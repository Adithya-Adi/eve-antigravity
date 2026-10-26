# eve-antigravity

Use the models from your local [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli) (`agy`) login inside [eve](https://eve.dev) agents. It works like eve's `chatgpt()` helper for a ChatGPT subscription, but for Antigravity.

```ts
// agent/agent.ts
import { defineAgent } from "eve";
import { antigravity, antigravityContextWindow } from "eve-antigravity";

export default defineAgent({
  model: antigravity("gemini-3.8-flash-high"),
  modelContextWindowTokens: antigravityContextWindow("gemini-3.8-flash-high"),
});
```

> [!WARNING]
> **Unofficial. Not affiliated with or endorsed by Google or Vercel.**
> This package drives the official `agy` binary as a subprocess. It does not reimplement Google's OAuth and does not call private endpoints directly. Even so, Google has not confirmed that consumer Antigravity plans may be orchestrated by other applications. Heavy or automated use may hit rate limits or lead to account action. Read the Antigravity terms and use this at your own risk.

## How it works

eve passes an [AI SDK](https://ai-sdk.dev) `LanguageModel` to its agent loop. `antigravity()` returns one. For each model call it:

1. Flattens the conversation (system prompt, messages, earlier tool calls and results) into a single prompt. Each call is stateless.
2. Runs `agy --print` with stream-json input and output, and sends the prompt on stdin.
3. If eve offers tools, adds them to the prompt and passes `--json-schema`. agy then finishes with `{ text, toolCalls }`.
4. Returns those tool calls to eve. **eve executes every tool**: built-in `bash`, your `agent/tools/*`, and MCP servers from `agent/connections/*`. agy only reasons.

agy runs from an isolated home (`~/.eve-antigravity`). Its `settings.json` denies all of agy's own tools (`command(*)`, `view_file(*)`, `write_file(*)`, `read_url(*)`), so agy can't act on its own and your personal agy allow list is never used. Your sign-in stays valid because agy keeps it in the OS keyring.

## Requirements

- Node.js 20+
- `agy` installed and signed in (run `agy` once and sign in with Google)
- eve 0.83+ (AI SDK v7 / `LanguageModelV4`)

```bash
npm install eve-antigravity
agy models   # list the model IDs your account can use
```

## API

### `antigravity(model?, settings?)`

Returns a `LanguageModelV4`. `model` defaults to `gemini-3.8-flash-medium`. An `antigravity/` prefix is accepted and stripped.

| Setting      | Default                                   | Description                                           |
| ------------ | ----------------------------------------- | ----------------------------------------------------- |
| `agyPath`    | `agy`                                     | Path to the agy executable                            |
| `agyArgs`    | `[]`                                      | Arguments placed before agy's flags (e.g. for `wsl`)  |
| `effort`     | agy default                               | `low`, `medium` or `high` (passed as `--effort`)      |
| `timeoutMs`  | `600000`                                  | Kill agy after this long                              |
| `runtimeDir` | `$EVE_ANTIGRAVITY_DIR` or `~/.eve-antigravity` | Isolated agy home and empty workspace            |
| `env`        | `{}`                                      | Extra environment variables for agy                   |

### `antigravityContextWindow(model?)`

eve looks up context windows in the AI Gateway catalog, and agy models aren't listed there. Pass this value as `modelContextWindowTokens`. Without it, eve refuses to compile the agent. Defaults: Gemini 1M, Claude 200K, other models 128K.

## Supported features

| Feature                           | Status                                                         |
| --------------------------------- | -------------------------------------------------------------- |
| Text generation and streaming     | Yes. Streams token deltas when no tools are offered            |
| Tool calling (eve tools, MCP)     | Yes, via structured output. Text arrives at the end of the step |
| `toolChoice` none/required/tool   | Yes                                                            |
| JSON output with a schema         | Yes (`--json-schema`)                                          |
| Usage (input/output/reasoning/cache) | Yes, from agy's result event                                |
| Images and files in prompts       | No. Replaced with a placeholder note                           |
| temperature, maxOutputTokens, etc. | No. Reported as AI SDK warnings                               |
| Provider-defined tools            | No. Reported as warnings                                       |

Each step resends the whole conversation, plus about 7K tokens of agy's own system prompt. Long agent loops use a lot of quota.

## Production and containers

On a desktop, agy keeps your Google sign-in in the OS keyring, so you can't copy it from your laptop into a container. Inside a Linux container without a keyring, agy saves the sign-in to a file instead: `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`. If you sign in once inside the container and keep that file on a volume, the login survives restarts. (Tested with agy 1.4.7 on `node:24-slim`.)

eve-antigravity runs agy with `HOME=<runtimeDir>/home`, so sign in with that same home:

```bash
# image: Linux agy on PATH (curl -fsSL https://antigravity.google/cli/install.sh | bash)
# pod: EVE_ANTIGRAVITY_DIR=/data/eve-antigravity, with /data on a persistent volume
kubectl exec -it <pod> -- sh -c 'mkdir -p "$EVE_ANTIGRAVITY_DIR/home" && cd "$EVE_ANTIGRAVITY_DIR" && HOME="$EVE_ANTIGRAVITY_DIR/home" agy'
# choose "1. Google OAuth", open the printed URL, sign in,
# paste the authorization code shown on antigravity.google, then quit agy
```

Container checklist:

1. Install agy in the image (Linux build) and put it on `PATH`, or set `agyPath`.
2. Set `EVE_ANTIGRAVITY_DIR` to a path on a **writable persistent volume**. agy refreshes the access token in place.
3. Sign in once as shown above. Repeat if the token is revoked or the volume is lost.
4. Treat the token file like a password. It grants access to your Google account's Antigravity and Cloud scopes. Never bake it into an image or commit it.

Alternatively, agy signs in without a browser via `GEMINI_API_KEY` (agy 1.1.13+) or a service account / Application Default Credentials (1.1.10+); see [google-antigravity/antigravity-cli#223](https://github.com/google-antigravity/antigravity-cli/issues/223). Both are billed per token instead of using your Antigravity plan. eve-antigravity passes the process environment through to agy.

> [!CAUTION]
> Using a personal Antigravity plan from a server that serves other people is the riskiest way to use this package. Every user's traffic counts against your account. eve's own `chatgpt()` helper is local-only for the same reason.

## Development

```bash
npm install
npm test          # unit tests against a fake agy
npm run typecheck
npm run build
```

## License

MIT
