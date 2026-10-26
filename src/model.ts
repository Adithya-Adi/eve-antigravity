import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  LanguageModelV4Usage,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { AgyError, runAgy, type AgyResult, type AgyUsage } from "./agy.js";
import { renderPrompt } from "./prompt.js";
import { prepareRuntime, type AgyRuntime } from "./runtime.js";
import {
  functionTools,
  parseToolCalls,
  readRecoveredToolCalls,
  recoverySchema,
  renderRecoveryPrompt,
  renderToolInstructions,
  ToolCallStream,
  type ToolCallRequest,
} from "./tools.js";

export interface AntigravitySettings {
  /** Path to the agy executable. Defaults to `agy` on PATH. */
  readonly agyPath?: string;
  /** Arguments placed before agy's flags, for wrappers such as `wsl agy`. */
  readonly agyArgs?: readonly string[];
  /** Reasoning effort passed to `agy --effort`. */
  readonly effort?: "low" | "medium" | "high";
  /** Kill agy after this many milliseconds. Defaults to 10 minutes. */
  readonly timeoutMs?: number;
  /**
   * Directory for the isolated agy home and workspace. Defaults to
   * `$EVE_ANTIGRAVITY_DIR` or `~/.eve-antigravity`.
   */
  readonly runtimeDir?: string;
  /** Extra environment variables for the agy process. */
  readonly env?: Readonly<Record<string, string>>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const UNSUPPORTED_SETTINGS = [
  "maxOutputTokens",
  "temperature",
  "stopSequences",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
] as const;

export class AntigravityLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "antigravity";
  readonly supportedUrls = {};

  constructor(
    readonly modelId: string,
    private readonly settings: AntigravitySettings = {},
  ) {}

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { stream, request } = await this.doStream(options);
    const content: LanguageModelV4Content[] = [];
    let text = "";
    let warnings: SharedV4Warning[] = [];
    let finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> | undefined;
    let modelId: string | undefined;

    const reader = stream.getReader();
    for (;;) {
      const { value: part, done } = await reader.read();
      if (done) break;
      switch (part.type) {
        case "stream-start":
          warnings = part.warnings;
          break;
        case "response-metadata":
          modelId = part.modelId;
          break;
        case "text-delta":
          text += part.delta;
          break;
        case "tool-call":
          content.push(part);
          break;
        case "error":
          throw part.error;
        case "finish":
          finish = part;
          break;
      }
    }
    if (text.length > 0) content.unshift({ type: "text", text });

    return {
      content,
      finishReason: finish?.finishReason ?? { unified: "other", raw: undefined },
      usage: finish?.usage ?? toUsage(undefined),
      warnings,
      ...(request && { request }),
      response: { modelId: modelId ?? this.modelId },
    };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    const runtime = await prepareRuntime(this.settings.runtimeDir);
    const tools = functionTools(options);
    const mode: Mode =
      tools.length > 0
        ? { kind: "tools" }
        : options.responseFormat?.type === "json" && options.responseFormat.schema
          ? { kind: "json", schema: options.responseFormat.schema }
          : { kind: "text" };
    const prompt = renderPrompt(
      options.prompt,
      mode.kind === "tools" ? renderToolInstructions(tools, options.toolChoice) : undefined,
    );
    const warnings = collectWarnings(options);
    const agy = {
      command: this.settings.agyPath ?? "agy",
      ...(this.settings.agyArgs && { prefixArgs: this.settings.agyArgs }),
      model: this.modelId,
      ...(this.settings.effort && { effort: this.settings.effort }),
      cwd: runtime.workspace,
      env: mergeEnv(runtime, this.settings.env),
      ...(options.abortSignal && { signal: options.abortSignal }),
      timeoutMs: this.settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    const events = runAgy({
      ...agy,
      prompt,
      ...(mode.kind === "json" && { jsonSchema: mode.schema }),
    });

    // Last resort when a tool block names no readable tool: ask agy, without
    // streaming and with a schema, which calls the reply intended.
    const recoverToolCalls = async (reply: string) => {
      let recovered: AgyResult | undefined;
      for await (const event of runAgy({
        ...agy,
        prompt: renderRecoveryPrompt(tools, reply),
        jsonSchema: recoverySchema(tools),
      })) {
        if (event.event === "result") recovered = event.result;
      }
      const calls = readRecoveredToolCalls(recovered?.structured_output);
      if (calls.length === 0) {
        throw new AgyError(
          `The model returned malformed tool calls that could not be recovered: ${reply.slice(-200)}`,
        );
      }
      return { calls, usage: recovered?.usage };
    };

    const modelId = this.modelId;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings });
        const textId = "text-0";
        let textOpen = false;
        const emitText = (delta: string) => {
          if (delta.length === 0) return;
          if (!textOpen) {
            controller.enqueue({ type: "text-start", id: textId });
            textOpen = true;
          }
          controller.enqueue({ type: "text-delta", id: textId, delta });
        };
        let result: AgyResult | undefined;
        // Tools mode: the reply is prose followed by an optional
        // <tool_calls> block. Stream the prose; parse the block at the end.
        const replies = mode.kind === "tools" ? new ToolCallStream() : undefined;
        try {
          for await (const event of events) {
            if (event.event === "init") {
              controller.enqueue({
                type: "response-metadata",
                modelId,
                ...(event.conversation_id && { id: event.conversation_id }),
              });
            } else if (event.event === "step_update") {
              const step = event.step_update;
              if (step.step_type !== "agent_response" || !step.text_delta) continue;
              if (replies) emitText(replies.push(step.text_delta));
              else if (mode.kind === "text") emitText(step.text_delta);
              // JSON response formats are emitted whole from the final result.
            } else if (event.event === "result") {
              result = event.result;
            }
          }

          let toolCalls: ToolCallRequest[] = [];
          let recoveryUsage: AgyUsage | undefined;
          if (replies) {
            const reply = replies.finish();
            emitText(reply.text);
            if (reply.block !== undefined) {
              const parsed = parseToolCalls(reply.block);
              if (parsed !== undefined) {
                toolCalls = parsed;
              } else {
                const recovered = await recoverToolCalls(replies.reply);
                toolCalls = recovered.calls;
                recoveryUsage = recovered.usage;
              }
            }
          } else if (mode.kind === "json") {
            emitText(
              result?.structured_output !== undefined
                ? JSON.stringify(result.structured_output)
                : (result?.response ?? ""),
            );
          }
          if (textOpen) controller.enqueue({ type: "text-end", id: textId });

          for (const call of toolCalls) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: `call_${randomUUID()}`,
              toolName: call.name,
              // Possibly invalid JSON: the AI SDK then reports the error to
              // the model as the tool result, and the model can retry.
              input: call.input,
            });
          }
          controller.enqueue({
            type: "finish",
            finishReason: finishReason(result, toolCalls.length > 0),
            usage: toUsage(addUsage(result?.usage, recoveryUsage)),
          });
        } catch (error) {
          controller.enqueue({ type: "error", error });
        } finally {
          controller.close();
        }
      },
      async cancel() {
        await events.return(undefined);
      },
    });

    return { stream, request: { body: { prompt } } };
  }
}

type Mode =
  | { readonly kind: "text" }
  | { readonly kind: "tools" }
  | { readonly kind: "json"; readonly schema: object };

function mergeEnv(
  runtime: AgyRuntime,
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return { ...runtime.env, ...extra };
}

function collectWarnings(options: LanguageModelV4CallOptions): SharedV4Warning[] {
  const warnings: SharedV4Warning[] = [];
  for (const feature of UNSUPPORTED_SETTINGS) {
    if (options[feature] !== undefined) warnings.push({ type: "unsupported", feature });
  }
  for (const tool of options.tools ?? []) {
    if (tool.type !== "function") {
      warnings.push({ type: "unsupported", feature: `provider tool ${tool.id}` });
    }
  }
  if (options.responseFormat?.type === "json" && options.responseFormat.schema === undefined) {
    warnings.push({
      type: "unsupported",
      feature: "responseFormat",
      details: "JSON output without a schema is not enforced.",
    });
  }
  return warnings;
}

function finishReason(
  result: AgyResult | undefined,
  calledTools: boolean,
): LanguageModelV4FinishReason {
  const unified = result?.status !== "SUCCESS" ? "other" : calledTools ? "tool-calls" : "stop";
  return { unified, raw: result?.status };
}

function toUsage(usage: AgyUsage | undefined): LanguageModelV4Usage {
  const input = usage?.input_tokens;
  const cacheRead = usage?.cache_read_tokens;
  const text = usage?.output_tokens;
  const reasoning = usage?.thinking_tokens;
  return {
    inputTokens: {
      total: input,
      noCache: input !== undefined ? input - (cacheRead ?? 0) : undefined,
      cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: text !== undefined || reasoning !== undefined ? (text ?? 0) + (reasoning ?? 0) : undefined,
      text,
      reasoning,
    },
    ...(usage && { raw: { ...usage } }),
  };
}

function addUsage(a: AgyUsage | undefined, b: AgyUsage | undefined): AgyUsage | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  const sum = (x: number | undefined, y: number | undefined) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const total: Record<string, number> = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "thinking_tokens",
    "cache_read_tokens",
    "total_tokens",
  ] as const) {
    const value = sum(a[key], b[key]);
    if (value !== undefined) total[key] = value;
  }
  return total;
}
