// The environment for a server that a check starts: the check's own, without the variables
// that hold a source control host's token or xAI's API key, and with a fresh HOME. Discovery
// (`server.discoverSourceControl`) then reads no CLI login of this machine (gh, glab, fj, ...),
// no token variable, and calls no host's API.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const TOKEN_VARIABLES =
  /^(ANTHROPIC_\w+|CLAUDE_\w+|CLAUDECODE|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST|CAFE_TOKEN|CAFE_HOST|T3CODE_BITBUCKET_\w+|T3CODE_GITHUB_APP_CLIENT_ID|GITLAB_TOKEN|GITLAB_HOST|GH_CONFIG_DIR|XDG_CONFIG_HOME|XDG_DATA_HOME|XAI_API_KEY)$/;

/** `dir` must be a fresh temp folder the check removes. */
export function sealedEnv(dir) {
  const home = NodePath.join(dir, "home");
  NodeFS.mkdirSync(home, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !TOKEN_VARIABLES.test(name)),
  );
  // The Claude status probe would run this machine's `claude` (and its login) at start.
  // CONN_MODEL_MANIFEST_URL=off: the server never fetches model-manifest.json from GitHub.
  return { ...env, HOME: home, CONN_CLAUDE_STATUS_PROBE: "off", CONN_MODEL_MANIFEST_URL: "off" };
}

/** What node and vitest need from the shell to run T3's code; nothing else passes. */
const RUNTIME_VARIABLES = ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL"];

/**
 * The environment for T3's own code that a proof runs (vitest in the Conn monorepo): only
 * `RUNTIME_VARIABLES` from the shell and a fresh HOME, so no `ANTHROPIC_*`, `CLAUDE_*`, token
 * or other variable of the shell reaches it, and `os.homedir()` finds no real home.
 * `dir` must be a fresh temp folder the check removes.
 */
export function sealedNodeEnv(dir) {
  const home = NodePath.join(dir, "home");
  NodeFS.mkdirSync(home, { recursive: true });
  const env = Object.fromEntries(
    RUNTIME_VARIABLES.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
  // No server of ours reads it there, but a check that starts one from this environment
  // must not fetch either.
  return { ...env, HOME: home, CONN_MODEL_MANIFEST_URL: "off" };
}
