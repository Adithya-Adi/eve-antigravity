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
import { runAgy, type AgyResult, type AgyUsage } from "./agy.js";
import { renderPrompt } from "./prompt.js";
import { prepareRuntime, type AgyRuntime } from "./runtime.js";

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
    const prompt = renderPrompt(options.prompt);
    const warnings = collectWarnings(options);
    const events = runAgy({
      command: this.settings.agyPath ?? "agy",
      ...(this.settings.agyArgs && { prefixArgs: this.settings.agyArgs }),
      model: this.modelId,
      ...(this.settings.effort && { effort: this.settings.effort }),
      prompt,
      cwd: runtime.workspace,
      env: mergeEnv(runtime, this.settings.env),
      ...(options.abortSignal && { signal: options.abortSignal }),
      timeoutMs: this.settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    const modelId = this.modelId;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings });
        const textId = "text-0";
        let textOpen = false;
        let result: AgyResult | undefined;
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
              if (step.step_type === "agent_response" && step.text_delta) {
                if (!textOpen) {
                  controller.enqueue({ type: "text-start", id: textId });
                  textOpen = true;
                }
                controller.enqueue({ type: "text-delta", id: textId, delta: step.text_delta });
              }
            } else if (event.event === "result") {
              result = event.result;
            }
          }
          if (textOpen) controller.enqueue({ type: "text-end", id: textId });
          controller.enqueue({
            type: "finish",
            finishReason: finishReason(result),
            usage: toUsage(result?.usage),
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
  if (options.tools !== undefined && options.tools.length > 0) {
    warnings.push({ type: "unsupported", feature: "tools" });
  }
  if (options.responseFormat?.type === "json") {
    warnings.push({ type: "unsupported", feature: "responseFormat" });
  }
  return warnings;
}

function finishReason(result: AgyResult | undefined): LanguageModelV4FinishReason {
  return { unified: result?.status === "SUCCESS" ? "stop" : "other", raw: result?.status };
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
