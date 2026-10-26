import type { LanguageModelV4CallOptions, LanguageModelV4FunctionTool } from "@ai-sdk/provider";

const OPEN_TAG = "<tool_calls>";
const CLOSE_TAG = "</tool_calls>";

export interface ToolCallRequest {
  readonly name: string;
  readonly input: unknown;
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
  const list = tools
    .map((tool) =>
      [
        `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`,
        `  input schema: ${JSON.stringify(tool.inputSchema)}`,
      ].join("\n"),
    )
    .join("\n");

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
${list}`;
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

  /** Ends the stream: returns remaining text and the parsed tool calls. */
  finish(): { readonly text: string; readonly toolCalls: ToolCallRequest[] } {
    if (this.blockStart === -1) {
      return { text: this.release(trimWhitespace(this.text, this.released, this.text.length)), toolCalls: [] };
    }
    const end = this.text.indexOf(CLOSE_TAG, this.blockStart);
    const body = this.text.slice(this.blockStart + OPEN_TAG.length, end === -1 ? undefined : end);
    const text = this.release(heldBackEnd(this.text, this.released, this.blockStart, true));
    return { text, toolCalls: parseToolCalls(body) };
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

export function parseToolCalls(body: string): ToolCallRequest[] {
  const json = body.trim().replace(/^```[a-z]*\s*/u, "").replace(/\s*```$/u, "");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`The model returned malformed tool calls: ${json.slice(0, 200)}`);
  }
  const calls = Array.isArray(value) ? value : [value];
  return calls.flatMap((call: unknown) => {
    if (typeof call !== "object" || call === null) return [];
    const { name, input } = call as { name?: unknown; input?: unknown };
    return typeof name === "string" && name.length > 0 ? [{ name, input: input ?? {} }] : [];
  });
}
