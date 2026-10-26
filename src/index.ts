import { AntigravityLanguageModel, type AntigravitySettings } from "./model.js";

export const DEFAULT_ANTIGRAVITY_MODEL = "gemini-3.8-flash-medium";

/**
 * Creates a language model served by the local Antigravity CLI (`agy`) and
 * billed to the Google account it is signed in with. Run `agy models` for the
 * IDs available to your account.
 *
 * ```ts
 * import { defineAgent } from "eve";
 * import { antigravity, antigravityContextWindow } from "eve-antigravity";
 *
 * export default defineAgent({
 *   model: antigravity("gemini-3.8-flash-high"),
 *   modelContextWindowTokens: antigravityContextWindow("gemini-3.8-flash-high"),
 * });
 * ```
 */
export function antigravity(
  model: string = DEFAULT_ANTIGRAVITY_MODEL,
  settings: AntigravitySettings = {},
): AntigravityLanguageModel {
  const id = model.trim().replace(/^antigravity\//u, "");
  if (id.length === 0 || id.includes("/")) {
    throw new Error(`Expected an agy model ID such as "${DEFAULT_ANTIGRAVITY_MODEL}"; received "${model}".`);
  }
  return new AntigravityLanguageModel(id, settings);
}

/**
 * Context window to pass as eve's `modelContextWindowTokens`. eve reads this
 * from the AI Gateway catalog for gateway models; agy models are not listed
 * there, so the agent must set it. Values leave headroom for agy's own system
 * prompt (about 7K tokens).
 */
export function antigravityContextWindow(model: string = DEFAULT_ANTIGRAVITY_MODEL): number {
  const id = model.replace(/^antigravity\//u, "");
  if (id.startsWith("gemini-")) return 1_000_000;
  if (id.startsWith("claude-")) return 200_000;
  return 128_000;
}

export { AntigravityLanguageModel, type AntigravitySettings } from "./model.js";
export { AgyError } from "./agy.js";
