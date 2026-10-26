import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AgyError,
  isAntigravitySignedIn,
  listAntigravityModels,
  startAntigravityLogin,
} from "../src/index.js";
import { extractUrl, stripAnsi } from "../src/login.js";

const FAKE_AGY = fileURLToPath(new URL("./fake-agy.mjs", import.meta.url));

async function options(scenario: string) {
  return {
    agyPath: process.execPath,
    agyArgs: [FAKE_AGY],
    runtimeDir: await mkdtemp(join(tmpdir(), "eve-antigravity-login-")),
    env: { FAKE_AGY_SCENARIO: scenario },
  };
}

describe("sign-in status", () => {
  it("lists models when signed in", async () => {
    const models = await listAntigravityModels(await options("text"));
    expect(models).toEqual(["gemini-3.8-flash-high", "claude-sonnet-4-6"]);
  });

  it("reports signed out with SIGN_IN_REQUIRED", async () => {
    const opts = await options("error");
    await expect(listAntigravityModels(opts)).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
    expect(await isAntigravitySignedIn(opts)).toBe(false);
  });

  it("reports a missing agy as NOT_INSTALLED", async () => {
    const opts = await options("text");
    await expect(
      listAntigravityModels({ ...opts, agyPath: "agy-does-not-exist-xyz", agyArgs: [] }),
    ).rejects.toMatchObject({ code: "NOT_INSTALLED" });
  });
});

describe("login screen parsing", () => {
  // Captured from agy 1.4.7 in an 80-column terminal, with the URL wrapped.
  const screen = [
    "\u001b[2m ⣾  Signing in...\u001b[0mYour browser should open automatically. If not:",
    " https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071-abc.apps",
    " .googleusercontent.com&code_challenge=nF_ax4N&redirect_uri=https%3A%2F%2Fantigravity.go",
    " ogle%2Foauth-callback&response_type=code&state=mNGfU6",
    " Copy and paste the URL or click on the link below:",
    " \u001b]8;;https://accounts.google.com/x\u0007→ Click here to authenticate\u001b]8;;\u0007",
    " If you aren't automatically redirected, paste the authorization code below:",
  ].join("\r\n");

  it("joins a wrapped sign-in URL", () => {
    expect(extractUrl(stripAnsi(screen))).toBe(
      "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071-abc.apps.googleusercontent.com&code_challenge=nF_ax4N&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=mNGfU6",
    );
  });

  it("ignores screens without a URL", () => {
    expect(extractUrl("Select login method:\n> 1. Google OAuth")).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("is unsupported on Windows", async () => {
    await expect(startAntigravityLogin(await options("text"))).rejects.toBeInstanceOf(AgyError);
  });
});

