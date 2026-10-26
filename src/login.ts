import { spawn, type ChildProcess } from "node:child_process";
import { AgyError, isSignInMessage, notInstalledError } from "./agy.js";
import { prepareRuntime } from "./runtime.js";

export interface AntigravityAuthOptions {
  /** Path to the agy executable. Defaults to `agy` on PATH. */
  readonly agyPath?: string;
  /** Arguments placed before agy's own arguments, as in `antigravity()`. */
  readonly agyArgs?: readonly string[];
  /** Same as the `runtimeDir` given to `antigravity()`. */
  readonly runtimeDir?: string;
  /** Extra environment variables for the agy process. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface AntigravityLoginOptions extends AntigravityAuthOptions {
  /** How long to wait for agy to print the sign-in URL. Defaults to 60 seconds. */
  readonly urlTimeoutMs?: number;
  /** How long the whole sign-in may stay open. Defaults to 10 minutes. */
  readonly timeoutMs?: number;
}

export interface AntigravityLogin {
  /** Google sign-in URL to show the user. */
  readonly url: string;
  /**
   * Sends the authorization code shown on antigravity.google after sign-in.
   * Resolves once agy has stored the session; rejects with an
   * {@link AgyError} (`LOGIN_FAILED`, `TIMEOUT`) otherwise.
   */
  submitCode(code: string): Promise<void>;
  /** Stops the sign-in and the agy process. */
  cancel(): void;
}

/**
 * Lists the models available to the signed-in account (`agy models`).
 * Throws {@link AgyError} with code `SIGN_IN_REQUIRED` when agy is signed out.
 * Makes no model call, so it costs no quota.
 */
export async function listAntigravityModels(options: AntigravityAuthOptions = {}): Promise<string[]> {
  const runtime = await prepareRuntime(options.runtimeDir);
  const command = options.agyPath ?? "agy";
  const child = spawn(command, [...(options.agyArgs ?? []), "models"], {
    cwd: runtime.workspace,
    env: { ...process.env, ...runtime.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? notInstalledError(command) : error),
    );
    child.once("close", resolve);
  });

  const output = `${stdout}\n${stderr}`;
  if (code !== 0) {
    if (isSignInMessage(output)) {
      throw new AgyError("agy is not signed in.", "SIGN_IN_REQUIRED");
    }
    throw new AgyError(`agy models failed (code ${code}): ${stderr.trim()}`);
  }
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.split("\t")[0]?.trim() ?? "")
    .filter((id) => id.length > 0 && !id.endsWith("..."));
}

/** Whether agy has a usable sign-in for the package's runtime home. */
export async function isAntigravitySignedIn(options: AntigravityAuthOptions = {}): Promise<boolean> {
  try {
    await listAntigravityModels(options);
    return true;
  } catch (error) {
    if (error instanceof AgyError && error.code === "SIGN_IN_REQUIRED") return false;
    throw error;
  }
}

const LOGIN_MENU = /Select login method/u;
const SIGNED_IN = /Choose your color scheme|Welcome to Antigravity CLI!/u;
const CODE_PROMPT = /authorization code/iu;
const LOGIN_ERROR = /(invalid[_ ]grant|invalid (authorization )?code|sign[- ]in failed|authentication failed|error:[^\n]*)/iu;

/**
 * Starts agy's interactive Google sign-in in a pseudo-terminal and returns
 * the URL to show the user. After signing in, Google redirects to
 * antigravity.google, which displays an authorization code; pass it to
 * {@link AntigravityLogin.submitCode}.
 *
 * Sign-in is stored for the same runtime home `antigravity()` uses. On a
 * Linux container without an OS keyring agy writes it to
 * `<runtimeDir>/home/.gemini/antigravity-cli/antigravity-oauth-token`.
 *
 * Requires `script` (util-linux on Linux, built in on macOS). On Windows,
 * run `agy` in a terminal instead.
 */
export async function startAntigravityLogin(
  options: AntigravityLoginOptions = {},
): Promise<AntigravityLogin> {
  if (process.platform === "win32") {
    throw new AgyError(
      "startAntigravityLogin() needs a POSIX `script` command. On Windows, run `agy` in a terminal to sign in.",
      "LOGIN_UNSUPPORTED",
    );
  }
  const runtime = await prepareRuntime(options.runtimeDir);
  const agy = options.agyPath ?? "agy";
  const child = spawn("script", scriptArgs([agy, ...(options.agyArgs ?? [])]), {
    cwd: runtime.workspace,
    env: {
      ...process.env,
      ...runtime.env,
      ...options.env,
      TERM: "xterm-256color",
      // A wide virtual terminal keeps the sign-in URL on one line.
      COLUMNS: "1000",
      LINES: "50",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const session = new LoginSession(child, agy, options.timeoutMs ?? 10 * 60_000);
  try {
    const url = await session.waitForUrl(options.urlTimeoutMs ?? 60_000);
    return {
      url,
      submitCode: (code) => session.submitCode(code),
      cancel: () => session.stop(),
    };
  } catch (error) {
    session.stop();
    throw error;
  }
}

function scriptArgs(command: readonly string[]): string[] {
  // util-linux: script -q -f -c CMD FILE; BSD/macOS: script -q FILE CMD...
  return process.platform === "darwin"
    ? ["-q", "/dev/null", ...command]
    : ["-q", "-f", "-c", command.map(shellQuote).join(" "), "/dev/null"];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

class LoginSession {
  private screen = "";
  private menuAnswered = false;
  private exited = false;
  private waiters = new Set<() => void>();
  private failure: AgyError | undefined;
  private readonly sessionTimer: NodeJS.Timeout;

  constructor(
    private readonly child: ChildProcess,
    agy: string,
    timeoutMs: number,
  ) {
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => this.onOutput(chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => this.onOutput(chunk));
    child.stdin?.on("error", () => {});
    child.once("error", (error: NodeJS.ErrnoException) => {
      this.fail(
        error.code === "ENOENT"
          ? new AgyError(
              "startAntigravityLogin() needs the `script` command (util-linux). Install it in the image.",
              "LOGIN_UNSUPPORTED",
            )
          : new AgyError(`Could not start agy sign-in: ${error.message}`, "LOGIN_FAILED"),
      );
    });
    child.once("close", () => {
      this.exited = true;
      if (/not found|No such file/iu.test(this.screen) && !LOGIN_MENU.test(this.screen)) {
        this.fail(notInstalledError(agy));
      }
      this.notify();
    });
    this.sessionTimer = setTimeout(() => {
      this.fail(new AgyError("agy sign-in timed out.", "TIMEOUT"));
      this.stop();
    }, timeoutMs);
    this.sessionTimer.unref();
  }

  async waitForUrl(timeoutMs: number): Promise<string> {
    const url = await this.waitFor(timeoutMs, () => {
      if (SIGNED_IN.test(this.screen) && !this.menuAnswered) {
        throw new AgyError("agy is already signed in.", "ALREADY_SIGNED_IN");
      }
      return CODE_PROMPT.test(this.screen) ? extractUrl(this.screen) : undefined;
    });
    // Only text after this point belongs to the code submission.
    this.screen = "";
    return url;
  }

  async submitCode(code: string): Promise<void> {
    const trimmed = code.trim();
    if (trimmed.length === 0 || /\s/u.test(trimmed)) {
      throw new AgyError("Expected a single authorization code.", "LOGIN_FAILED");
    }
    this.write(trimmed);
    // agy's input field treats a pasted CR as text; send Enter separately.
    await delay(500);
    this.write("\r");
    try {
      await this.waitFor(120_000, () => {
        if (SIGNED_IN.test(this.screen)) return true;
        const error = this.screen.match(LOGIN_ERROR);
        if (error) throw new AgyError(`agy sign-in failed: ${error[0].trim()}`, "LOGIN_FAILED");
        return undefined;
      });
    } finally {
      // The session is stored once agy reaches onboarding; nothing else is needed.
      this.stop();
    }
  }

  stop(): void {
    clearTimeout(this.sessionTimer);
    if (this.exited || this.child.pid === undefined) return;
    try {
      // Kill the whole group: script, agy, and agy's language server.
      process.kill(-this.child.pid, "SIGTERM");
    } catch {
      this.child.kill("SIGTERM");
    }
  }

  private onOutput(chunk: string): void {
    this.screen += stripAnsi(chunk);
    if (this.screen.length > 200_000) this.screen = this.screen.slice(-100_000);
    if (!this.menuAnswered && LOGIN_MENU.test(this.screen)) {
      this.menuAnswered = true;
      // "1. Google OAuth" is preselected.
      this.write("\r");
    }
    this.notify();
  }

  private write(text: string): void {
    this.child.stdin?.write(text);
  }

  private fail(error: AgyError): void {
    this.failure ??= error;
    this.notify();
  }

  private notify(): void {
    for (const waiter of this.waiters) waiter();
  }

  private waitFor<T>(timeoutMs: number, check: () => T | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const finish = (action: () => void) => {
        clearTimeout(timer);
        this.waiters.delete(evaluate);
        action();
      };
      const evaluate = () => {
        try {
          const value = check();
          if (value !== undefined) return finish(() => resolve(value));
        } catch (error) {
          return finish(() => reject(error));
        }
        if (this.failure) return finish(() => reject(this.failure));
        if (this.exited) {
          return finish(() =>
            reject(new AgyError(`agy exited during sign-in.${tail(this.screen)}`, "LOGIN_FAILED")),
          );
        }
      };
      const timer = setTimeout(
        () => finish(() => reject(new AgyError("agy sign-in timed out.", "TIMEOUT"))),
        timeoutMs,
      );
      this.waiters.add(evaluate);
      evaluate();
    });
  }
}

/** Joins the sign-in URL even if the terminal wrapped it across lines. */
export function extractUrl(screen: string): string | undefined {
  const start = screen.lastIndexOf("https://accounts.google.com/");
  if (start === -1) return undefined;
  const rest = screen.slice(start);
  const end = rest.search(/Copy and paste|Click here|authorization code|─/u);
  const url = (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/gu, "");
  return /^https:\/\/accounts\.google\.com\/[^\s]+$/u.test(url) ? url : undefined;
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\x1b[@-Z\\-_]/gu, "")
    .replace(/\r/gu, "");
}

function tail(screen: string): string {
  const last = screen.trim().split("\n").slice(-3).join(" ").trim();
  return last ? ` Last output: ${last.slice(0, 300)}` : "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
