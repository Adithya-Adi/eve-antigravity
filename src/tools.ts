import type { LanguageModelV4CallOptions, LanguageModelV4FunctionTool } from "@ai-sdk/provider";

/** Final answer shape agy must produce when tools are offered. */
export interface ToolTurn {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
}

export function functionTools(options: LanguageModelV4CallOptions): LanguageModelV4FunctionTool[] {
  if (options.toolChoice?.type === "none") return [];
  const tools = (options.tools ?? []).filter(
    (tool): tool is LanguageModelV4FunctionTool => tool.type === "function",
  );
  const choice = options.toolChoice;
  return choice?.type === "tool" ? tools.filter((tool) => tool.name === choice.toolName) : tools;
}

export function toolTurnSchema(tools: readonly LanguageModelV4FunctionTool[]): object {
  return {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Plain-prose message to the user. Never JSON. May be empty when calling tools.",
      },
      toolCalls: {
        type: "array",
        description: "Tools for the runtime to execute, in order. Empty when the answer is final.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: tools.map((tool) => tool.name) },
            input: { type: "object", description: "Arguments matching the tool's input schema." },
          },
          required: ["name", "input"],
        },
      },
    },
    required: ["text", "toolCalls"],
  };
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
      ? "You must request at least one tool call in this turn."
      : "Request tool calls only when an action or information you lack is needed; otherwise return toolCalls = [] with your final answer in text.";

  return `TOOLS:
You cannot act yourself. Never use your own built-in tools (run_command, view_file, list_dir, browser, search, etc.); they are disabled. The runtime executes the tools below for you: request them through toolCalls, and their results appear in the conversation as [tool result ...] blocks on the next turn.
${requirement}
Finish with text = your plain-prose message to the user (no JSON) and toolCalls = the requested calls.

AVAILABLE TOOLS:
${list}`;
}

export function parseToolTurn(value: unknown): ToolTurn | undefined {
  if (typeof value === "string") {
    try {
      return parseToolTurn(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { text, toolCalls } = value as { text?: unknown; toolCalls?: unknown };
  const calls = Array.isArray(toolCalls)
    ? toolCalls.flatMap((call: unknown) => {
        if (typeof call !== "object" || call === null) return [];
        const { name, input } = call as { name?: unknown; input?: unknown };
        return typeof name === "string" && name.length > 0 ? [{ name, input: input ?? {} }] : [];
      })
    : [];
  return { text: typeof text === "string" ? text : "", toolCalls: calls };
}
