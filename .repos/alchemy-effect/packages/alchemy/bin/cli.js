#!/usr/bin/env node
// @ts-check
// alchemy CLI launcher
//
// Resolves the alchemy CLI entrypoint via node module resolution and execs it
// under whichever runtime the user invoked us with. The shebang forces this
// launcher to run as node even when bun was the invoker, but bun forwards
// signals about itself via env vars on every child it spawns:
//
//   - `npm_execpath`           → path to bun (set for `bun run <script>`)
//   - `npm_config_user_agent`  → "bun/<version> ..." (set for `bun run`,
//                                `bunx`, and direct bun-launched bins)
//
// Either signal is enough to know bun is the outer runtime.
//
// Dev vs published: when this launcher runs out of an alchemy checkout
// (i.e. *not* from inside a `node_modules/` tree) and bun is available, we
// run the .ts source directly so dev iteration is edit → reload, no rebuild.
// The published tarball ships the .ts files as well (alchemy's `bun`/`worker`
// exports point at .ts source), but consumers install into `node_modules/`,
// so the path check sends them to the bundled `alchemy.js` regardless.
//
// Own the spawn so bun's hard-coded watcher warning can be filtered while
// signals, IPC messages, and the child's exit status are forwarded.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import path from "pathe";

/**
 * Run the CLI as a foreground child while retaining the launcher's filtered
 * stderr and IPC forwarding. Effect's child-process service intentionally
 * doesn't expose Node's IPC channel, so this small launcher keeps that boundary
 * on the native Node API.
 *
 * @param {string} program
 * @param {ReadonlyArray<string>} args
 * @param {(line: string) => boolean} stderrFilter
 */
const foregroundChild = (program, args, stderrFilter) => {
  /** @type {import("node:child_process").StdioOptions} */
  const stdio = process.send ? [0, 1, "pipe", "ipc"] : [0, 1, "pipe"];
  const child = spawn(program, args, { stdio });
  /** @type {Map<NodeJS.Signals, () => void>} */
  const listeners = new Map();

  for (const signal of /** @type {Array<NodeJS.Signals>} */ (
    Object.keys(constants.signals)
  )) {
    if (signal === "SIGKILL" || signal === "SIGSTOP") continue;
    const forward = () => child.kill(signal);
    try {
      process.on(signal, forward);
      listeners.set(signal, forward);
    } catch {}
  }

  let buffer = "";
  child.stderr?.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/(?<=\n)/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (stderrFilter(line)) process.stderr.write(line);
    }
  });
  child.stderr?.on("end", () => {
    if (buffer && stderrFilter(buffer)) process.stderr.write(buffer);
  });

  if (process.send) {
    child.on("message", (message, handle) =>
      process.send?.(
        /** @type {import("node:child_process").Serializable} */ (message),
        handle,
      ),
    );
    process.on("message", (message, handle) =>
      child.send(
        /** @type {import("node:child_process").Serializable} */ (message),
        handle,
      ),
    );
  }

  child.on("close", (code, signal) => {
    for (const [name, listener] of listeners) {
      process.removeListener(name, listener);
    }
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
};

const execpath = (process.env.npm_execpath ?? "").toLowerCase();
const userAgent = (process.env.npm_config_user_agent ?? "").toLowerCase();
const invokedByBun = execpath.includes("bun") || userAgent.startsWith("bun/");

// Derive the bin dir from this launcher's own location rather than
// require.resolve("alchemy/bin/alchemy.js"). The bundled alchemy.js is a
// build artifact (tsdown output) and may not exist in a fresh checkout
// (e.g. CI before `bun run build`); resolving it would throw
// MODULE_NOT_FOUND before we get a chance to fall back to the .ts source.
const binDir = path.dirname(fileURLToPath(import.meta.url));
const jsEntry = path.join(binDir, "alchemy.js");
const tsEntry = path.join(binDir, "alchemy.ts");

// Treat any install-tree path as published.
const isDev = !(
  binDir.includes("/node_modules/") || binDir.includes("\\node_modules\\")
);

// We no longer force bun in dev when node is the invoker because this prevents us from testing in node.
const runtime = invokedByBun ? "bun" : "node";

const args = [];

if (runtime === "bun" && isDev) {
  // Pin bun's tsconfig to alchemy's, not whatever happens to be in the
  // invoking workspace's cwd. Bun's default is `$cwd/tsconfig.json`, which
  // means invoking `alchemy` from e.g. `examples/cloudflare-solidstart`
  // would transpile alchemy's own .tsx files with that example's JSX
  // settings (jsx: "preserve", jsxImportSource: "solid-js"), breaking the
  // React files inside the alchemy CLI.
  args.push(`--tsconfig-override=${path.join(binDir, "..", "tsconfig.json")}`);
}

// .ts only runs under bun.
args.push(runtime === "bun" ? tsEntry : jsEntry, ...process.argv.slice(2));

// Substring match (not regex) — bun may wrap the line in ANSI color codes
// when stderr is piped to a TTY-aware parent, so anchored regex is fragile.
//
// "directory mismatch for directory" is bun's known-benign internal warning
// triggered by --tsconfig-override (oven-sh/bun#25730): the resolver openat()s
// the tsconfig basename against a cached dir fd that isn't its parent, falls
// back to an absolute open, and logs. Bun's own tsconfig-override tests
// tolerate the same line. Only our dev path passes --tsconfig-override, which
// is why published installs never see it.
foregroundChild(
  runtime,
  args,
  (line) =>
    !line.includes("is not in the project directory and will not be watched") &&
    !line.includes("directory mismatch for directory"),
);
