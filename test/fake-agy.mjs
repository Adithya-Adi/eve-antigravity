// Stand-in for the agy CLI. Reads one stream-json user message from stdin and
// replays canned print-mode events selected by FAKE_AGY_SCENARIO.
import { appendFileSync } from "node:fs";

if (process.argv[2] === "models") {
  process.stderr.write("Fetching available models...\n");
  if (process.env.FAKE_AGY_SCENARIO === "error") {
    process.stderr.write("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n");
    process.exit(1);
  }
  process.stdout.write("gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n");
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const message = JSON.parse(input.trim().split("\n")[0]);
  if (process.env.FAKE_AGY_LOG) {
    // One JSON line per agy invocation.
    appendFileSync(
      process.env.FAKE_AGY_LOG,
      `${JSON.stringify({
        args: process.argv.slice(2),
        prompt: message.message.content,
        cwd: process.cwd(),
        home: process.env.HOME,
      })}\n`,
    );
  }
  const id = "conv-1";
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const usage = { input_tokens: 100, output_tokens: 5, thinking_tokens: 3, cache_read_tokens: 40, total_tokens: 108 };
  // agy streams replies in small chunks; 5 characters splits the tag too.
  const streamText = (stepIndex, text) => {
    for (let i = 0; i < text.length; i += 5) {
      emit({ event: "step_update", step_update: { step_index: stepIndex, state: "ACTIVE", step_type: "agent_response", text_delta: text.slice(i, i + 5) } });
    }
  };

  switch (process.env.FAKE_AGY_SCENARIO ?? "text") {
    case "text":
      emit({ event: "init", conversation_id: id, init: { model: "fake" } });
      emit({ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } });
      emit({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "hello " } });
      emit({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "world", usage } });
      emit({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: "hello world", usage } });
      process.exit(0);
    case "tool-loop": {
      // First turn requests a tool; once a tool result is in the prompt, answer.
      const answered = /\[tool result \w+ id=/.test(message.message.content);
      const reply = answered
        ? "The directory has README.md."
        : 'Listing the files.\n```json\n<tool_calls>[{"name": "bash", "input": {"command": "ls"}}]</tool_calls>\n```';
      emit({ event: "init", conversation_id: id });
      streamText(1, reply);
      emit({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: reply, usage } });
      process.exit(0);
    }
    case "malformed-tools":
    case "recovery-fails":
    case "bad-input": {
      const prompt = message.message.content;
      if (prompt.includes("but the block is malformed")) {
        // The package's recovery call: answer with schema output.
        const structured = {
          toolCalls: process.env.FAKE_AGY_SCENARIO === "recovery-fails" ? [] : [{ name: "bash", input: { command: "ls" } }],
        };
        emit({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: JSON.stringify(structured), structured_output: structured, usage } });
        process.exit(0);
      }
      const answered = /\[tool result \w+ id=/.test(prompt);
      const reply = answered
        ? "Done."
        : process.env.FAKE_AGY_SCENARIO === "bad-input"
          ? 'Checking.<tool_calls>[{"name": "bash", "input": {command: ls}}]</tool_calls>'
          : "Checking.<tool_calls>[{name: bash, input: {command: ls}}]</tool_calls>";
      emit({ event: "init", conversation_id: id });
      streamText(1, reply);
      emit({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: reply, usage } });
      process.exit(0);
    }
    case "json": {
      const structured = { city: "Paris" };
      emit({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: JSON.stringify(structured), structured_output: structured, usage } });
      process.exit(0);
    }
    case "error":
      emit({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "You are not logged into Antigravity." } });
      process.exit(1);
    case "no-result":
      process.stderr.write("boom");
      process.exit(2);
    case "hang":
      emit({ event: "init", conversation_id: id });
      setInterval(() => {}, 1000);
      break;
  }
});
