import { describe, expect, it } from "vitest";
import { parseToolCalls, ToolCallStream } from "../src/tools.js";

function run(reply: string, size: number) {
  const stream = new ToolCallStream();
  const deltas: string[] = [];
  for (let i = 0; i < reply.length; i += size) {
    const delta = stream.push(reply.slice(i, i + size));
    if (delta) deltas.push(delta);
  }
  const end = stream.finish();
  if (end.text) deltas.push(end.text);
  return { text: deltas.join(""), deltas, toolCalls: end.toolCalls };
}

describe("ToolCallStream", () => {
  const block = '<tool_calls>[{"name":"current_time","input":{"timeZone":"Asia/Tokyo"}},{"name":"bash","input":{"command":"ls"}}]</tool_calls>';

  it.each([1, 2, 3, 5, 11, 500])("splits prose and tool calls in %i-character chunks", (size) => {
    const result = run(`Checking both now.\n\n${block}\n`, size);
    expect(result.text).toBe("Checking both now.");
    expect(result.toolCalls).toEqual([
      { name: "current_time", input: { timeZone: "Asia/Tokyo" } },
      { name: "bash", input: { command: "ls" } },
    ]);
    expect(result.deltas.some((delta) => delta.includes("<"))).toBe(false);
  });

  it("streams a plain answer progressively and keeps markdown intact", () => {
    const answer = "Here is code:\n```ts\nconst a = `x`;\n```\nUse `ls` and a < b.";
    const result = run(answer, 4);
    expect(result.text).toBe(answer);
    expect(result.toolCalls).toEqual([]);
    expect(result.deltas.length).toBeGreaterThan(5);
  });

  it("drops a code fence wrapped around the block", () => {
    const result = run(`Listing.\n\`\`\`json\n${block}\n\`\`\``, 3);
    expect(result.text).toBe("Listing.");
    expect(result.toolCalls).toHaveLength(2);
  });

  it("keeps a closing inline backtick right before the block", () => {
    expect(run(`Running \`ls\`\n${block}`, 2).text).toBe("Running `ls`");
  });

  it("handles a block with no prose", () => {
    const result = run(block, 7);
    expect(result.text).toBe("");
    expect(result.toolCalls).toHaveLength(2);
  });

  it("accepts a missing closing tag", () => {
    expect(run('<tool_calls>[{"name":"bash","input":{}}]', 4).toolCalls).toEqual([
      { name: "bash", input: {} },
    ]);
  });
});

describe("parseToolCalls", () => {
  it("accepts a single object and fenced JSON", () => {
    expect(parseToolCalls('```json\n{"name":"bash","input":{"command":"ls"}}\n```')).toEqual([
      { name: "bash", input: { command: "ls" } },
    ]);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseToolCalls("[{name: bash}]")).toThrow(/malformed tool calls/);
  });
});
