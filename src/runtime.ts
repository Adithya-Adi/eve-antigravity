import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * agy settings for the isolated home. eve executes every tool itself, so agy
 * must never act on its own: deny every built-in action category and keep it
 * out of files outside its empty workspace.
 */
const LOCKED_SETTINGS = {
  allowNonWorkspaceAccess: false,
  permissions: {
    allow: [],
    deny: ["command(*)", "read_url(*)", "write_file(*)", "view_file(*)"],
    ask: [],
  },
};

export interface AgyRuntime {
  /** Empty working directory agy runs in. */
  readonly workspace: string;
  /** Environment overrides that point agy at the isolated home. */
  readonly env: Readonly<Record<string, string>>;
}

export function defaultRuntimeDir(): string {
  return process.env.EVE_ANTIGRAVITY_DIR ?? join(homedir(), ".eve-antigravity");
}

const prepared = new Map<string, Promise<AgyRuntime>>();

/**
 * Prepares `<dir>/home` (agy settings) and `<dir>/workspace` (cwd) once per
 * process. agy keeps its login in the OS keyring, so an isolated HOME keeps
 * the user's session while ignoring their personal allow list.
 */
export function prepareRuntime(dir: string = defaultRuntimeDir()): Promise<AgyRuntime> {
  let runtime = prepared.get(dir);
  if (runtime === undefined) {
    runtime = createRuntime(dir);
    runtime.catch(() => prepared.delete(dir));
    prepared.set(dir, runtime);
  }
  return runtime;
}

async function createRuntime(dir: string): Promise<AgyRuntime> {
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  const settingsDir = join(home, ".gemini", "antigravity-cli");
  await mkdir(settingsDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(settingsDir, "settings.json"), JSON.stringify(LOCKED_SETTINGS, null, 2));
  return { workspace, env: { HOME: home, USERPROFILE: home } };
}
