// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Standalone Node watch launcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const serverDir = NodePath.resolve(import.meta.dirname, "..");
const entry = "src/bin.ts";
const packageDirs = [
  serverDir,
  ...NodeFS.globSync("../../packages/*/package.json", { cwd: serverDir }).map((file) =>
    NodePath.resolve(serverDir, NodePath.dirname(file)),
  ),
];

let child: NodeChildProcess.ChildProcess | undefined;
let startedAt = 0;
let restartPending = false;
let stopping = false;
let debounce: NodeJS.Timeout | undefined;
const changedPaths = new Set<string>();

// `node --watch` cannot be used: on Windows, libuv reports NTFS last-access updates as changes,
// so merely reading a source file (or an installed dependency directory) restarted the server.
// A path counts as changed only when it is gone or written since the running server started.
const isWrittenSinceStart = (path: string) => {
  try {
    const stats = NodeFS.statSync(path);
    return !stats.isDirectory() && Math.max(stats.mtimeMs, stats.ctimeMs) >= startedAt;
  } catch {
    return true;
  }
};

const start = () => {
  startedAt = Date.now();
  restartPending = false;
  child = NodeChildProcess.spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    cwd: serverDir,
    stdio: "inherit",
  });
  child.on("error", (error) => console.error(error));
  child.on("exit", (code, signal) => {
    child = undefined;
    if (stopping) {
      process.exitCode = code ?? (signal === null ? 1 : 128 + NodeOS.constants.signals[signal]);
      return;
    }
    if (restartPending) return start();
    console.log(
      `[dev] '${entry}' exited (${signal ?? code}). Waiting for file changes before restarting...`,
    );
  });
};

const flush = () => {
  debounce = undefined;
  const changed = [...changedPaths].find(isWrittenSinceStart);
  changedPaths.clear();
  if (changed === undefined || stopping || restartPending) return;
  console.log(`[dev] Restarting '${entry}': ${NodePath.relative(serverDir, changed)} changed`);
  if (!child) return start();
  restartPending = true;
  child.kill("SIGTERM");
};

const onChange = (path: string) => {
  changedPaths.add(path);
  debounce ??= setTimeout(flush, 200);
};

// Watch only each workspace package's src and package.json, never its node_modules.
const watchers = packageDirs.flatMap((dir) => {
  const src = NodePath.join(dir, "src");
  return [
    NodeFS.watch(dir, (_event, name) => {
      if (name === "package.json") onChange(NodePath.join(dir, name));
    }),
    ...(NodeFS.existsSync(src)
      ? [
          NodeFS.watch(src, { recursive: true }, (_event, name) =>
            onChange(name ? NodePath.join(src, name) : src),
          ),
        ]
      : []),
  ];
});

const stop = (signal: NodeJS.Signals) => {
  stopping = true;
  clearTimeout(debounce);
  for (const watcher of watchers) watcher.close();
  if (child) child.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGHUP", () => stop("SIGTERM"));

start();
