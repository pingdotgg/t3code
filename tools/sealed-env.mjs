// The environment for a server that a check starts: the check's own, without the variables
// that hold a source control host's token or xAI's API key, and with a fresh HOME. Discovery
// (`server.discoverSourceControl`) then reads no CLI login of this machine (gh, glab, fj, ...),
// no token variable, and calls no host's API.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const TOKEN_VARIABLES =
  /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST|CAFE_TOKEN|CAFE_HOST|T3CODE_BITBUCKET_\w+|T3CODE_GITHUB_APP_CLIENT_ID|GITLAB_TOKEN|GITLAB_HOST|GH_CONFIG_DIR|XDG_CONFIG_HOME|XDG_DATA_HOME|XAI_API_KEY)$/;

/** `dir` must be a fresh temp folder the check removes. */
export function sealedEnv(dir) {
  const home = NodePath.join(dir, "home");
  NodeFS.mkdirSync(home, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !TOKEN_VARIABLES.test(name)),
  );
  return { ...env, HOME: home };
}
