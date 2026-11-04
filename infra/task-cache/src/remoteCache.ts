// @effect-diagnostics nodeBuiltinImport:off - Vite configuration also loads before dependency installation.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export function remoteCacheUrl(root: string, env = process.env, home = NodeOS.homedir()) {
  if (env.VP_REMOTE_CACHE_URL) return env.VP_REMOTE_CACHE_URL;
  try {
    const { endpoint } = JSON.parse(
      NodeFS.readFileSync(NodePath.join(root, ".task-cache.json"), "utf8"),
    );
    const credentials = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, ".config/t3-task-cache/credentials.json"), "utf8"),
    );
    const credential = credentials[endpoint];
    if (
      typeof endpoint !== "string" ||
      typeof credential?.name !== "string" ||
      typeof credential.token !== "string"
    )
      return;
    const url = new URL(endpoint);
    url.username = credential.name;
    url.password = credential.token;
    return url.href;
  } catch {
    // Missing or damaged optional setup must not prevent ordinary project commands.
    return;
  }
}
