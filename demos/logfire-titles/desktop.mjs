import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone launcher has no Effect runtime.
const windows = NodeOS.platform() === "win32";
const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const workspace = `${root}.t3/recording-desktop`;
const home = `${workspace}/.t3`;
const origin = "http://127.0.0.1:14242";
const webOrigin = "http://localhost:6202";
const projectId = "logfire-title-demo";
const previousRecording = await NodeFSP.readFile(`${workspace}/recording.json`, "utf8")
  .then(JSON.parse)
  .catch(() => null);
const investigatorId = previousRecording?.investigatorId ?? "logfire-title-investigation";
const modelSelection = {
  instanceId: "codex",
  model: "gpt-6-astra",
  options: [{ id: "reasoningEffort", value: "medium" }],
};
for (const port of [14242, 6202]) {
  await new Promise((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", () => reject(new Error(`Recording port ${port} is already in use.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
// Seed only the corpus into a new home; the project is then bound to the editable checkout.
const corpusPath = `${workspace}/demos/logfire-titles/corpus.json`;
await NodeFSP.mkdir(`${workspace}/demos/logfire-titles`, { recursive: true });
await NodeFSP.mkdir(`${home}/userdata/electron`, { recursive: true });
await NodeFSP.copyFile(`${root}demos/logfire-titles/corpus.json`, corpusPath);
const env = {
  ...loadRepoEnv(),
  T3CODE_HOME: home,
  T3CODE_PORT: "14242",
  T3CODE_PORT_OFFSET: "469",
  VITE_DEV_SERVER_URL: webOrigin,
  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
  T3CODE_LOGFIRE_TITLE_CORPUS: corpusPath,
};
for (const key of [
  "T3CODE_DESKTOP_WS_URL",
  "T3CODE_DEV_AUTH_TOKEN",
  "T3_SERVICE_LAUNCHER_CONTEXT",
  "T3_BOOT_SERVICE_UNIT",
  "ELECTRON_RUN_AS_NODE",
])
  delete env[key];
// The built backend is deliberately not watched: the investigator can edit and evaluate safely.
Object.assign(process.env, env);
const { resolveElectronLaunchCommand } =
  await import("../../apps/desktop/scripts/electron-launcher.mjs");
const command = resolveElectronLaunchCommand(["dist-electron/main.cjs"]);
const web = NodeChildProcess.spawn(
  process.execPath,
  ["scripts/dev-runner.ts", "dev:web", "--home-dir", home, "--port", "14242"],
  {
    cwd: root,
    env,
    stdio: "inherit",
    detached: !windows,
  },
);
const app = NodeChildProcess.spawn(command.electronPath, command.args, {
  cwd: `${root}apps/desktop`,
  env,
  stdio: "inherit",
});
await NodeFSP.writeFile(
  `${workspace}/launcher.json`,
  JSON.stringify({ pid: process.pid, appPid: app.pid, webPid: web.pid, origin, home }),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  app.kill("SIGTERM");
  if (windows) web.kill("SIGTERM");
  else if (web.pid) process.kill(-web.pid, "SIGTERM");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
app.once("exit", stop);
async function ready(url) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Desktop exited: ${app.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Not ready: ${url}`);
}
try {
  const environment = await (await ready(`${origin}/.well-known/t3/environment`)).json();
  await ready(webOrigin);
  const { token } = JSON.parse(
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        "apps/server/src/bin.ts",
        "auth",
        "session",
        "issue",
        "--base-dir",
        home,
        "--ttl",
        "12h",
        "--label",
        "Recording setup",
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const request = async (route, body) => {
    const response = await fetch(`${origin}${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response.json();
  };
  const dispatch = (command) =>
    request("/api/orchestration/dispatch", { commandId: NodeCrypto.randomUUID(), ...command });
  await dispatch({
    type: "project.meta.update",
    projectId,
    workspaceRoot: root.replace(/\/$/, ""),
    defaultModelSelection: modelSelection,
  });
  const shell = await request("/api/orchestration/shell");
  if (!shell.threads.some((thread) => thread.id === investigatorId))
    await dispatch({
      type: "thread.create",
      projectId,
      threadId: investigatorId,
      title: "Why are these titles bad?",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "demo/logfire-live",
      worktreePath: null,
      createdAt: new Date().toISOString(),
    });
  const url = `${webOrigin}/${environment.environmentId}/${investigatorId}`;
  await NodeFSP.writeFile(
    `${workspace}/recording.json`,
    JSON.stringify(
      { origin, home, environmentId: environment.environmentId, url, investigatorId, projectId },
      null,
      2,
    ),
  );
  console.log(`Recording desktop ready: ${url}`);
  console.log(
    `Paste: ${(await NodeFSP.readFile(`${root}demos/logfire-titles/investigate.md`, "utf8")).trim()}`,
  );
} catch (error) {
  stop();
  throw error;
}
