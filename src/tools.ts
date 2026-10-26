import type { LanguageModelV4CallOptions, LanguageModelV4FunctionTool } from "@ai-sdk/provider";

const OPEN_TAG = "<tool_calls>";
const CLOSE_TAG = "</tool_calls>";

export interface ToolCallRequest {
  readonly name: string;
  /** Arguments as JSON text. May be invalid JSON when salvaged from a broken block. */
  readonly input: string;
}

export function functionTools(options: LanguageModelV4CallOptions): LanguageModelV4FunctionTool[] {
  if (options.toolChoice?.type === "none") return [];
  const tools = (options.tools ?? []).filter(
    (tool): tool is LanguageModelV4FunctionTool => tool.type === "function",
  );
  const choice = options.toolChoice;
  return choice?.type === "tool" ? tools.filter((tool) => tool.name === choice.toolName) : tools;
}

export function renderToolInstructions(
  tools: readonly LanguageModelV4FunctionTool[],
  choice: LanguageModelV4CallOptions["toolChoice"],
): string {
  const requirement =
    choice?.type === "required" || choice?.type === "tool"
      ? "You must end this reply with a tool call block."
      : "Call tools only when you need an action or information you lack. Otherwise omit the block; your whole reply is then the final answer.";

  return `TOOLS:
You cannot act yourself. Never use your own built-in tools (run_command, view_file, list_dir, browser, search, etc.); they are disabled. The runtime executes the tools below for you, and their results appear in later turns as [tool result ...] blocks.
To call tools, end your reply with exactly one block:
${OPEN_TAG}[{"name": "<tool name>", "input": {<arguments matching its input schema>}}]${CLOSE_TAG}
Write any message for the user as plain prose before the block, and put nothing after it.
${requirement}

AVAILABLE TOOLS:
${renderToolList(tools)}`;
}

function renderToolList(tools: readonly LanguageModelV4FunctionTool[]): string {
  return tools
    .map((tool) =>
      [
        `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`,
        `  input schema: ${JSON.stringify(tool.inputSchema)}`,
      ].join("\n"),
    )
    .join("\n");
}

/**
 * Splits a streamed reply into user-facing text and a trailing
 * `<tool_calls>[...]</tool_calls>` block. Text is released as it arrives,
 * except for trailing whitespace or anything that could be the start of
 * the block, which is held back until the next chunk decides it.
 */
export class ToolCallStream {
  private text = "";
  private released = 0;
  private blockStart = -1;

  /** Appends a chunk and returns text that is safe to show. */
  push(chunk: string): string {
    this.text += chunk;
    if (this.blockStart !== -1) return "";
    this.blockStart = this.text.indexOf(OPEN_TAG, Math.max(0, this.released - OPEN_TAG.length));
    const limit = this.blockStart !== -1 ? this.blockStart : this.safeLength();
    return this.release(heldBackEnd(this.text, this.released, limit));
  }

  /** Ends the stream: returns the remaining text and the raw tool block, if any. */
  finish(): { readonly text: string; readonly block: string | undefined } {
    if (this.blockStart === -1) {
      return {
        text: this.release(trimWhitespace(this.text, this.released, this.text.length)),
        block: undefined,
      };
    }
    const end = this.text.indexOf(CLOSE_TAG, this.blockStart);
    const block = this.text.slice(this.blockStart + OPEN_TAG.length, end === -1 ? undefined : end);
    const text = this.release(heldBackEnd(this.text, this.released, this.blockStart, true));
    return { text, block };
  }

  /** The whole reply so far, including any tool block. */
  get reply(): string {
    return this.text;
  }

  private release(until: number): string {
    if (until <= this.released) return "";
    const out = this.text.slice(this.released, until);
    this.released = until;
    return out;
  }

  /** Length that cannot be part of an opening tag still being written. */
  private safeLength(): number {
    for (let size = Math.min(OPEN_TAG.length - 1, this.text.length); size > 0; size--) {
      if (OPEN_TAG.startsWith(this.text.slice(-size))) return this.text.length - size;
    }
    return this.text.length;
  }
}

function trimWhitespace(text: string, from: number, to: number): number {
  let end = to;
  while (end > from && /\s/u.test(text[end - 1]!)) end -= 1;
  return end;
}

/**
 * End of text[from, to) minus trailing whitespace and a trailing code-fence
 * opener: models sometimes wrap the block in ```json, which must not leak.
 */
function heldBackEnd(text: string, from: number, to: number, final = false): number {
  let end = trimWhitespace(text, from, to);
  // While streaming, hold any trailing backticks until the next chunk; at the
  // end, drop only a real fence line.
  const fence = (final ? /(?:^|\n)```[a-z]*$/u : /`{1,3}[a-z]*$/u).exec(text.slice(from, end));
  if (fence) end = trimWhitespace(text, from, end - fence[0].length);
  return end;
}

/**
 * Reads the tool calls in a `<tool_calls>` block. Valid JSON is used as is.
 * A broken block is salvaged per call: each `"name": "..."` becomes a call
 * whose input is the `"input"` object text after it, even if that text is
 * not valid JSON, so the AI SDK reports the error back to the model.
 * Returns `undefined` when no tool name can be recovered.
 */
export function parseToolCalls(block: string): ToolCallRequest[] | undefined {
  const json = block.trim().replace(/^```[a-z]*\s*/u, "").replace(/\s*```$/u, "");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return salvageToolCalls(json);
  }
  return toToolCalls(Array.isArray(value) ? value : [value]);
}

function toToolCalls(calls: readonly unknown[]): ToolCallRequest[] {
  return calls.flatMap((call: unknown) => {
    if (typeof call !== "object" || call === null) return [];
    const { name, input } = call as { name?: unknown; input?: unknown };
    return typeof name === "string" && name.length > 0
      ? [{ name, input: JSON.stringify(input ?? {}) }]
      : [];
  });
}

function salvageToolCalls(text: string): ToolCallRequest[] | undefined {
  const names = [...text.matchAll(/"name"\s*:\s*"([^"]+)"/gu)];
  if (names.length === 0) return undefined;
  return names.map((match, index) => {
    const from = match.index + match[0].length;
    const to = names[index + 1]?.index ?? text.length;
    const input = /"input"\s*:\s*/u.exec(text.slice(from, to));
    return {
      name: match[1]!,
      input: input ? objectText(text, from + input.index + input[0].length) : "",
    };
  });
}

/** Text of the `{...}` starting at `start`, honouring strings; to the end if unbalanced. */
function objectText(text: string, start: number): string {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start).trim();
}

/** Schema for the non-streamed recovery call when no tool name can be read. */
export function recoverySchema(tools: readonly LanguageModelV4FunctionTool[]): object {
  return {
    type: "object",
    properties: {
      toolCalls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: tools.map((tool) => tool.name) },
            input: { type: "object" },
          },
          required: ["name", "input"],
        },
      },
    },
    required: ["toolCalls"],
  };
}

export function renderRecoveryPrompt(
  tools: readonly LanguageModelV4FunctionTool[],
  reply: string,
): string {
  return `An assistant wrote the reply below and tried to request tools in a ${OPEN_TAG} block, but the block is malformed. Return the tool calls it intended. Never use your own tools. Return toolCalls = [] if it intended none.

AVAILABLE TOOLS:
${renderToolList(tools)}

REPLY:
${reply}`;
}

export function readRecoveredToolCalls(value: unknown): ToolCallRequest[] {
  const calls = (value as { toolCalls?: unknown } | undefined)?.toolCalls;
  return Array.isArray(calls) ? toToolCalls(calls) : [];
}
