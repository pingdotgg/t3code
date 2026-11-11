// @effect-diagnostics nodeBuiltinImport:off - installs the hook before running project tasks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

if (process.env.GITHUB_REPOSITORY !== "pingdotgg/t3code" || process.env.GITHUB_ACTIONS !== "true")
  throw new Error("This setup is only for the maintainer repository's GitHub Actions.");
const root = NodePath.resolve(import.meta.dirname, "../../..");
const hookConfig = NodePath.join(NodeOS.homedir(), ".config/vite-plus/run-hook.json");
await NodeFSP.mkdir(NodePath.dirname(hookConfig), { recursive: true });
await NodeFSP.writeFile(
  hookConfig,
  JSON.stringify({
    rootMarker: ".task-cache.json",
    module: NodePath.join(root, "infra/task-cache/src/runHook.ts"),
  }),
);
const { endpoint } = JSON.parse(
  await NodeFSP.readFile(NodePath.join(root, ".task-cache.json"), "utf8"),
);
const token = process.env.T3_TASK_CACHE_READ_TOKEN;
if (!token || token.length < 32) throw new Error("Missing task-cache read credential");
const credentialFile = NodePath.join(NodeOS.homedir(), ".config/t3-task-cache/credentials.json");
await NodeFSP.mkdir(NodePath.dirname(credentialFile), { recursive: true, mode: 0o700 });
await NodeFSP.writeFile(
  credentialFile,
  JSON.stringify({ [endpoint]: { name: "ci-reader", token } }),
  { mode: 0o600 },
);
const githubEnv = process.env.GITHUB_ENV;
if (!githubEnv) throw new Error("Missing GitHub Actions environment file");
const directory = process.env.RUNNER_TEMP;
if (!directory) throw new Error("Missing GitHub Actions temporary directory");
const shellSetup = NodePath.join(directory, "t3-task-cache.sh");
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const preload = NodeURL.pathToFileURL(NodePath.join(root, "infra/task-cache/src/preload.mjs")).href;
// GitHub prohibits NODE_OPTIONS in GITHUB_ENV; bash exports it to task subprocesses instead.
await NodeFSP.writeFile(
  shellSetup,
  [
    process.env.BASH_ENV && process.env.BASH_ENV !== shellSetup
      ? `. ${quote(process.env.BASH_ENV)}`
      : "",
    `export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }"${quote(`--import=${preload}`)}`,
    "",
  ].join("\n"),
);
await NodeFSP.appendFile(githubEnv, `BASH_ENV=${shellSetup}\n`);
