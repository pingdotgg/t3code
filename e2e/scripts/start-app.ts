// @effect-diagnostics nodeBuiltinImport:off globalDate:off - plain Node launcher spawned by the e2e runner, outside any Effect runtime.
/**
 * Boots one isolated T3 Code server for an e2e run: `node scripts/start-app.ts <port>`.
 *
 * The server serves the prebuilt web bundle and keeps its state in a fresh temp T3 home.
 * It runs with `isolatedEnv`: a throwaway HOME and XDG dirs and an allowlisted
 * environment, so neither it nor its terminals can reach the developer's credentials.
 * Codex is the scripted fixtures/fake-codex CLI and every other provider is disabled.
 * It auto-bootstraps a small git repository as its first project. The instance directory
 * is removed when the server stops; directories left by a killed launcher are pruned on
 * the next start.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts/settings";

import {
  FAKE_CODEX_DIR,
  FIXTURES_DIR,
  FIXTURE_PROJECT_NAME,
  INSTANCES_ROOT,
  SERVER_BIN,
  WEB_DIST_INDEX,
  type InstancePaths,
  instancePaths,
  isolatedEnv,
} from "../support/instance.ts";
import { writeFixtureRepository } from "../support/repository.ts";

const port = process.argv[2];
if (port === undefined || !/^\d+$/.test(port)) {
  throw new Error("Usage: node scripts/start-app.ts <port>");
}
if (!NodeFS.existsSync(WEB_DIST_INDEX)) {
  throw new Error("apps/web/dist is missing. Build it first: vp run --filter @t3tools/web build");
}

pruneStaleInstances();
const paths = instancePaths(port);
NodeFS.rmSync(paths.root, { recursive: true, force: true });
NodeFS.mkdirSync(paths.userHome, { recursive: true });
NodeFS.writeFileSync(NodePath.join(paths.root, "launcher.pid"), String(process.pid));
NodeFS.writeFileSync(
  NodePath.join(paths.userHome, ".gitconfig"),
  "[user]\n\tname = T3 E2E\n\temail = e2e@t3.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
);
writeServerSettings(paths);

const env = isolatedEnv(paths);
writeFixtureRepository(paths.project, FIXTURE_PROJECT_NAME, env);

const server = NodeChildProcess.spawn(
  process.execPath,
  [
    SERVER_BIN,
    "--port",
    port,
    "--host",
    "127.0.0.1",
    "--base-dir",
    paths.t3Home,
    "--no-browser",
    "--auto-bootstrap-project-from-cwd",
  ],
  { cwd: paths.project, env, stdio: "inherit" },
);

// The e2e runner signals the whole process group; forwarding covers a launcher started by hand.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.kill(signal));
}

server.on("exit", (code) => {
  NodeFS.rmSync(paths.root, { recursive: true, force: true });
  process.exit(code ?? 0);
});

/**
 * Points each provider at its scripted fake CLI, so every turn is deterministic, and
 * turns off provider update checks, which would reach npm.
 */
function writeServerSettings({ t3Home }: InstancePaths) {
  const disabled = { enabled: false };
  const fake = (relativePath: string) => ({
    enabled: true,
    binaryPath: NodePath.join(FIXTURES_DIR, relativePath),
  });
  // Keyed by every provider the contract knows, so a new provider fails typecheck here
  // instead of starting enabled and probing a real CLI.
  const providers: Record<keyof ServerSettings["providers"], object> = {
    codex: { binaryPath: NodePath.join(FAKE_CODEX_DIR, "codex") },
    claudeAgent: fake("fake-claude/claude"),
    cursor: disabled,
    grok: fake("fake-acp/grok"),
    pi: fake("fake-pi/pi"),
    opencode: fake("fake-opencode/opencode"),
    antigravity: fake("fake-acp/antigravity"),
  };
  const settings = { enableProviderUpdateChecks: false, providers } satisfies ServerSettingsPatch;
  NodeFS.mkdirSync(NodePath.join(t3Home, "userdata"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(t3Home, "userdata", "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

/**
 * Removes instance directories whose launcher is no longer running. A directory without
 * a pid file is only pruned once it is a minute old, since a concurrent launcher may be
 * about to write one.
 */
function pruneStaleInstances() {
  if (!NodeFS.existsSync(INSTANCES_ROOT)) return;
  for (const entry of NodeFS.readdirSync(INSTANCES_ROOT)) {
    const root = NodePath.join(INSTANCES_ROOT, entry);
    const pidFile = NodePath.join(root, "launcher.pid");
    const stale = NodeFS.existsSync(pidFile)
      ? !isRunning(Number(NodeFS.readFileSync(pidFile, "utf8")))
      : Date.now() - NodeFS.statSync(root).mtimeMs > 60_000;
    if (stale) NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

/** Whether a process with `pid` exists. */
function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
