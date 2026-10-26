import type { LanguageModelV4Prompt } from "@ai-sdk/provider";

const PREAMBLE = `You are the language model behind an external agent runtime. Answer as the assistant in the conversation below.`;

/**
 * Flattens an AI SDK prompt into one text prompt. agy runs a fresh,
 * stateless turn per model call, so the whole conversation is sent each time.
 */
export function renderPrompt(prompt: LanguageModelV4Prompt): string {
  const system = prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);

  const transcript: string[] = [];
  for (const message of prompt) {
    switch (message.role) {
      case "system":
        break;
      case "user":
        transcript.push(
          section(
            "user",
            message.content
              .map((part) => (part.type === "text" ? part.text : fileNote(part.mediaType)))
              .join("\n"),
          ),
        );
        break;
      case "assistant": {
        const lines: string[] = [];
        for (const part of message.content) {
          if (part.type === "text") lines.push(part.text);
          else if (part.type === "file") lines.push(fileNote(part.mediaType));
          else if (part.type === "tool-call") {
            lines.push(
              `[tool call ${part.toolName} id=${part.toolCallId}] ${JSON.stringify(part.input ?? {})}`,
            );
          }
        }
        transcript.push(section("assistant", lines.join("\n")));
        break;
      }
      case "tool":
        for (const part of message.content) {
          if (part.type !== "tool-result") continue;
          transcript.push(
            section(
              `tool result ${part.toolName} id=${part.toolCallId}`,
              renderToolOutput(part.output),
            ),
          );
        }
        break;
    }
  }

  return [
    PREAMBLE,
    system.length > 0 ? `SYSTEM INSTRUCTIONS:\n${system.join("\n\n")}` : undefined,
    `CONVERSATION:\n${transcript.join("\n\n")}`,
  ]
    .filter((block) => block !== undefined)
    .join("\n\n");
}

function section(label: string, body: string): string {
  return `[${label}]\n${body}`;
}

function fileNote(mediaType: string): string {
  return `[attached ${mediaType} file omitted: not supported by eve-antigravity]`;
}

type ToolOutput = Extract<
  LanguageModelV4Prompt[number],
  { role: "tool" }
>["content"][number] extends infer Part
  ? Part extends { type: "tool-result"; output: infer Output }
    ? Output
    : never
  : never;

function renderToolOutput(output: ToolOutput): string {
  switch (output.type) {
    case "text":
      return output.value;
    case "error-text":
      return `ERROR: ${output.value}`;
    case "json":
      return JSON.stringify(output.value);
    case "error-json":
      return `ERROR: ${JSON.stringify(output.value)}`;
    case "execution-denied":
      return `Tool execution denied${output.reason ? `: ${output.reason}` : "."}`;
    case "content":
      return output.value
        .map((item) => (item.type === "text" ? item.text : `[${item.type} omitted]`))
        .join("\n");
    default:
      return JSON.stringify(output);
  }
}
