import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface AgyUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly thinking_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly total_tokens?: number;
}

export interface AgyStepUpdate {
  readonly step_index?: number;
  readonly state?: string;
  readonly step_type?: string;
  readonly text_delta?: string;
  readonly tool_name?: string;
  readonly usage?: AgyUsage;
}

export interface AgyResult {
  readonly conversation_id?: string;
  readonly status: string;
  readonly response?: string;
  readonly structured_output?: unknown;
  readonly error?: string;
  readonly usage?: AgyUsage;
  readonly denied_actions?: ReadonlyArray<{ readonly action?: string }>;
}

export type AgyEvent =
  | { readonly event: "init"; readonly conversation_id?: string }
  | { readonly event: "step_update"; readonly step_update: AgyStepUpdate }
  | { readonly event: "result"; readonly result: AgyResult };

export interface AgyRunOptions {
  /** Executable to spawn. */
  readonly command: string;
  /** Arguments placed before agy's own flags (for wrappers such as `wsl agy`). */
  readonly prefixArgs?: readonly string[];
  readonly model: string;
  readonly effort?: "low" | "medium" | "high";
  readonly prompt: string;
  /** JSON schema the final answer must satisfy. */
  readonly jsonSchema?: object;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type AgyErrorCode =
  | "NOT_INSTALLED"
  | "SIGN_IN_REQUIRED"
  | "ALREADY_SIGNED_IN"
  | "LOGIN_FAILED"
  | "LOGIN_UNSUPPORTED"
  | "TIMEOUT"
  | "FAILED";

export class AgyError extends Error {
  constructor(
    message: string,
    readonly code: AgyErrorCode = "FAILED",
    readonly result?: AgyResult,
  ) {
    super(message);
    this.name = "AgyError";
  }
}

export function buildAgyArgs(options: AgyRunOptions): string[] {
  return [
    ...(options.prefixArgs ?? []),
    // The prompt arrives on stdin, which avoids OS command-line length limits.
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--model",
    options.model,
    ...(options.effort ? ["--effort", options.effort] : []),
    ...(options.jsonSchema ? ["--json-schema", JSON.stringify(options.jsonSchema)] : []),
    "-p",
    "",
  ];
}

/**
 * Runs one agy print-mode turn and yields its NDJSON events. The final event
 * is always a `result`; a failed run throws {@link AgyError} after yielding it.
 */
export async function* runAgy(options: AgyRunOptions): AsyncGenerator<AgyEvent> {
  options.signal?.throwIfAborted();

  const child = spawn(options.command, buildAgyArgs(options), {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 16_384) stderr += chunk;
  });

  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? notInstalledError(options.command)
          : error,
      );
    });
  });
  spawnError.catch(() => {});
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));

  const kill = () => child.kill();
  options.signal?.addEventListener("abort", kill, { once: true });
  const timer =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? setTimeout(kill, options.timeoutMs)
      : undefined;

  child.stdin.on("error", () => {});
  child.stdin.end(
    `${JSON.stringify({ event: "user", message: { content: options.prompt } })}\n`,
    "utf8",
  );

  let result: AgyResult | undefined;
  try {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([iterator.next(), spawnError]);
      if (next.done) break;
      const event = parseEvent(next.value);
      if (event === undefined) continue;
      if (event.event === "result") result = event.result;
      yield event;
    }
    const code = await exited;
    options.signal?.throwIfAborted();
    if (result === undefined) {
      if (timer !== undefined && code === null) {
        throw new AgyError(`agy timed out after ${options.timeoutMs}ms.`, "TIMEOUT");
      }
      throw new AgyError(
        `agy exited (code ${code}) without a result.${stderr ? ` ${stderr.trim()}` : ""}`,
      );
    }
    if (result.status !== "SUCCESS") {
      throw failureError(result);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

function parseEvent(line: string): AgyEvent | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value === "object" && value !== null && "event" in value) {
      return value as AgyEvent;
    }
  } catch {
    // agy may print non-JSON diagnostics; skip them.
  }
  return undefined;
}

export function notInstalledError(command: string): AgyError {
  return new AgyError(
    `Could not find the Antigravity CLI ("${command}"). Install agy and sign in, or pass agyPath.`,
    "NOT_INSTALLED",
  );
}

export function isSignInMessage(message: string): boolean {
  return /not (logged|signed) in|sign in|unauthenticated|authenticat/i.test(message);
}

function failureError(result: AgyResult): AgyError {
  const error = result.error ?? `status ${result.status}`;
  if (isSignInMessage(error)) {
    return new AgyError(
      `agy is not signed in (${error}). Run \`agy\` once and sign in with your Google account, or use startAntigravityLogin().`,
      "SIGN_IN_REQUIRED",
      result,
    );
  }
  return new AgyError(`agy failed: ${error}`, "FAILED", result);
}
