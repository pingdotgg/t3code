#!/usr/bin/env node
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
// We use @alchemy.run/node-utils' foreground-child so we can pipe the
// child's stderr through a filter — upstream hardcodes stdio = [0, 1, 2],
// so the only way to drop bun's hard-coded watcher warning ("warn: File
// <path> is not in the project directory and will not be watched", which is
// noise in our monorepo and has no bun flag to silence) is to own the spawn
// call. Everything else — signal proxying, watchdog, IPC bridging, exit-code
// forwarding — matches upstream.
import { fileURLToPath } from "node:url";
import path from "pathe";
import { foregroundChild } from "@alchemy.run/node-utils";

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

process.on("uncaughtException", (error) => {
  // STATUS_CONTROL_C_EXIT on Windows — the watchdog inherits Ctrl-C from the
  // console and exits with this code instead of a SIGINT signal.
  const WIN_CTRL_C = 3221225786;
  if (
    error.message.includes(
      "foreground-child watchdog process died unexpectedly!",
    ) &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "watchedProcess" in error.cause &&
    error.cause.watchedProcess !== null &&
    "cmd" in error.cause.watchedProcess &&
    (error.cause.signal === "SIGINT" || error.cause.code === WIN_CTRL_C)
  ) {
    console.log("Interrupted.");
    process.exit(0);
  }
  console.error(error);
});

// Substring match (not regex) — bun may wrap the line in ANSI color codes
// when stderr is piped to a TTY-aware parent, so anchored regex is fragile.
foregroundChild(runtime, args, {
  stderrFilter: (line) =>
    !line.includes("is not in the project directory and will not be watched"),
});
