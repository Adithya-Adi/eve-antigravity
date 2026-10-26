import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateText, Output, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgyError, antigravity, antigravityContextWindow } from "../src/index.js";

const FAKE_AGY = fileURLToPath(new URL("./fake-agy.mjs", import.meta.url));

let dir: string;
let log: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eve-antigravity-test-"));
  log = join(dir, "agy-call.json");
});

afterEach(() => {
  delete process.env.FAKE_AGY_SCENARIO;
});

function model(scenario: string, settings: { timeoutMs?: number } = {}) {
  return antigravity("gemini-3.8-flash-low", {
    agyPath: process.execPath,
    agyArgs: [FAKE_AGY],
    runtimeDir: dir,
    env: { FAKE_AGY_SCENARIO: scenario, FAKE_AGY_LOG: log },
    ...settings,
  });
}

async function lastCall() {
  return JSON.parse(await readFile(log, "utf8")) as {
    args: string[];
    prompt: string;
    cwd: string;
    home: string;
  };
}

describe("antigravity()", () => {
  it("rejects provider-qualified ids from other providers", () => {
    expect(() => antigravity("openai/gpt-5")).toThrow(/agy model ID/);
    expect(antigravity("antigravity/gemini-3.8-flash-low").modelId).toBe("gemini-3.8-flash-low");
  });

  it("suggests a context window per model family", () => {
    expect(antigravityContextWindow("gemini-3.8-flash-high")).toBe(1_000_000);
    expect(antigravityContextWindow("antigravity/claude-sonnet-4-6")).toBe(200_000);
    expect(antigravityContextWindow("gpt-oss-120b-medium")).toBe(128_000);
  });

  it("generates text and maps usage", async () => {
    const result = await generateText({
      model: model("text"),
      system: "Be brief.",
      prompt: "Say hello",
    });

    expect(result.text).toBe("hello world");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(8);
    expect(result.usage.inputTokenDetails.cacheReadTokens).toBe(40);
    expect(result.usage.outputTokenDetails.reasoningTokens).toBe(3);
  });

  it("sends the prompt on stdin and runs inside the isolated runtime", async () => {
    await generateText({ model: model("text"), system: "Be brief.", prompt: "Say hello" });
    const call = await lastCall();

    expect(call.args).toEqual(
      expect.arrayContaining(["--input-format", "stream-json", "--model", "gemini-3.8-flash-low"]),
    );
    expect(call.prompt).toContain("SYSTEM INSTRUCTIONS:\nBe brief.");
    expect(call.prompt).toContain("[user]\nSay hello");
    expect(call.cwd).toBe(join(dir, "workspace"));
    expect(call.home).toBe(join(dir, "home"));

    const settings = JSON.parse(
      await readFile(join(dir, "home", ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    );
    expect(settings.permissions.deny).toContain("command(*)");
    expect(settings.allowNonWorkspaceAccess).toBe(false);
  });

  it("streams text deltas", async () => {
    const result = streamText({ model: model("text"), prompt: "Say hello" });
    const deltas: string[] = [];
    for await (const delta of result.textStream) deltas.push(delta);
    expect(deltas).toEqual(["hello ", "world"]);
  });

  it("returns tool calls for the runtime and answers from tool results", async () => {
    const executed: string[] = [];
    const result = await generateText({
      model: model("tool-loop"),
      prompt: "What files are here?",
      tools: {
        bash: tool({
          description: "Run a bash command.",
          inputSchema: z.object({ command: z.string() }),
          execute: async ({ command }) => {
            executed.push(command);
            return "README.md";
          },
        }),
      },
      stopWhen: stepCountIs(3),
    });

    expect(executed).toEqual(["ls"]);
    expect(result.steps[0]?.finishReason).toBe("tool-calls");
    expect(result.steps[0]?.text).toBe("");
    expect(result.text).toBe("The directory has README.md.");
    expect(result.finishReason).toBe("stop");

    const call = await lastCall();
    expect(call.prompt).toContain("AVAILABLE TOOLS:\n- bash: Run a bash command.");
    expect(call.prompt).toMatch(/\[tool call bash id=call_[\w-]+\] \{"command":"ls"\}/);
    expect(call.prompt).toMatch(/\[tool result bash id=call_[\w-]+\]\nREADME\.md/);
    const schema = JSON.parse(call.args[call.args.indexOf("--json-schema") + 1]!);
    expect(schema.properties.toolCalls.items.properties.name.enum).toEqual(["bash"]);
  });

  it("does not offer tools when toolChoice is none", async () => {
    await generateText({
      model: model("text"),
      prompt: "hi",
      tools: { bash: tool({ inputSchema: z.object({ command: z.string() }) }) },
      toolChoice: "none",
    });
    const call = await lastCall();
    expect(call.args).not.toContain("--json-schema");
    expect(call.prompt).not.toContain("AVAILABLE TOOLS");
  });

  it("enforces JSON response schemas", async () => {
    const result = await generateText({
      model: model("json"),
      prompt: "Capital of France?",
      output: Output.object({ schema: z.object({ city: z.string() }) }),
    });
    expect(result.output).toEqual({ city: "Paris" });
    expect((await lastCall()).args).toContain("--json-schema");
  });

  it("surfaces sign-in failures", async () => {
    await expect(model("error").doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }))
      .rejects.toThrow(/not signed in/);
  });

  it("reports agy exiting without a result", async () => {
    await expect(model("no-result").doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }))
      .rejects.toBeInstanceOf(AgyError);
  });

  it("kills agy on abort", async () => {
    const controller = new AbortController();
    const pending = model("hang").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("kills agy on timeout", async () => {
    await expect(
      model("hang", { timeoutMs: 300 }).doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    ).rejects.toThrow(/timed out/);
  });
});
