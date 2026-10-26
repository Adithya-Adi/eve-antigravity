// Stand-in for the agy CLI. Reads one stream-json user message from stdin and
// replays canned print-mode events selected by FAKE_AGY_SCENARIO.
import { writeFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const message = JSON.parse(input.trim().split("\n")[0]);
  if (process.env.FAKE_AGY_LOG) {
    writeFileSync(
      process.env.FAKE_AGY_LOG,
      JSON.stringify({
        args: process.argv.slice(2),
        prompt: message.message.content,
        cwd: process.cwd(),
        home: process.env.HOME,
      }),
    );
  }
  const id = "conv-1";
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const usage = { input_tokens: 100, output_tokens: 5, thinking_tokens: 3, cache_read_tokens: 40, total_tokens: 108 };

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
      const structured = answered
        ? { text: "The directory has README.md.", toolCalls: [] }
        : { text: "", toolCalls: [{ name: "bash", input: { command: "ls" } }] };
      emit({ event: "init", conversation_id: id });
      // Schema mode streams the raw JSON as response text; it must not leak.
      emit({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: JSON.stringify(structured) } });
      emit({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: JSON.stringify(structured), structured_output: structured, usage } });
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
