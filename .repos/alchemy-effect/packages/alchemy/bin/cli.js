#!/usr/bin/env node
// @ts-check
// alchemy CLI launcher
//
// Resolves the alchemy CLI entrypoint and runs it under whichever runtime the
// user invoked us with — in this very process whenever that is possible, by
// replacing this process with bun when the CLI needs no flags, and as a
// foreground child only when it does (see the bottom of this file). The
// shebang forces this launcher to run as node even when bun was the
// invoker, but bun forwards signals about itself via env vars on every child
// it spawns:
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
// When a child is needed, own the spawn so runtime diagnostics can be
// filtered while signals, IPC messages, and the child's exit status are
// forwarded.
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import * as NodeModule from "node:module";
import { constants } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    // The lookbehind split KEEPS separators, so a chunk ending in "\n"
    // yields a COMPLETE final element — unconditionally popping it held
    // the last line of every stderr burst (e.g. an error trace's final
    // frame) until the next write or stream end, where it surfaced after
    // Ctrl+C looking like unrelated output. Only buffer a genuine partial.
    buffer =
      lines.length > 0 && !lines[lines.length - 1].endsWith("\n")
        ? (lines.pop() ?? "")
        : "";
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

/**
 * The bun executable, as an absolute path, or `undefined` when it cannot be
 * found. `bun run` names itself in `npm_execpath`; otherwise walk `PATH`.
 * `process.execve` does no lookup of its own and aborts the process on a
 * missing file, so this must be certain before handing off.
 *
 * @returns {string | undefined}
 */
const findBun = () => {
  const execpath = process.env.npm_execpath;
  if (execpath && path.basename(execpath).startsWith("bun")) {
    return existsSync(execpath) ? execpath : undefined;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory === "") continue;
    const candidate = path.join(directory, "bun");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
};

// Namespace access, not a named import: this launcher must still reach the
// version error below on Nodes that predate the compile cache (< 22.1).
NodeModule.enableCompileCache?.();

const execpath = (process.env.npm_execpath ?? "").toLowerCase();
const userAgent = (process.env.npm_config_user_agent ?? "").toLowerCase();
// `typeof Bun`: someone ran `bun bin/cli.js` directly (no bun env markers,
// shebang bypassed) — the launcher itself IS bun, so bun is the runtime.
const invokedByBun =
  execpath.includes("bun") ||
  userAgent.startsWith("bun/") ||
  typeof globalThis.Bun !== "undefined";

// Derive the bin dir from this launcher's own location rather than
// require.resolve("alchemy/bin/alchemy.js"). The bundled alchemy.js is a
// build artifact (tsdown output) and may not exist in a fresh checkout
// (e.g. CI before `bun run build`); resolving it would throw
// MODULE_NOT_FOUND before we get a chance to fall back to the .ts source.
const binDir = path.dirname(fileURLToPath(import.meta.url));
const jsEntry = path.join(binDir, "alchemy.js");
const tsEntry = path.join(binDir, "alchemy.ts");

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node
  .split(".")
  .map(Number);

/**
 * Whether this node has `module.registerHooks` (v22.15 / v23.5 / v24+).
 * Alchemy loads every `.ts`/`.tsx` — its own source in a checkout, the
 * user's stack everywhere — through the Oxc loader those hooks install, and
 * never through Node's built-in TypeScript support (strip-only, and its
 * transform flag was removed in Node 26). So this is THE gate for running
 * under node at all. Mirrors `src/Util/Node.ts#isRegisterHooksSupported` —
 * duplicated because this launcher must run under plain node first.
 */
const nodeSupportsHooks =
  (nodeMajor === 22 && nodeMinor >= 15) ||
  (nodeMajor === 23 && nodeMinor >= 5) ||
  nodeMajor >= 24;

// Treat any install-tree path as published.
const isDev = !(
  binDir.includes("/node_modules/") || binDir.includes("\\node_modules\\")
);

// We no longer force bun in dev when node is the invoker because this prevents us from testing in node.
const runtime = invokedByBun ? "bun" : "node";

if (runtime === "node" && !nodeSupportsHooks) {
  process.stderr.write(
    `alchemy: node ${process.versions.node} is not supported ` +
      "(module.registerHooks needs node 22.15+, 23.5+, or 24+).\n" +
      "Use a newer node, or run alchemy with bun.\n",
  );
  process.exit(1);
}

const entry = runtime === "bun" || isDev ? tsEntry : jsEntry;
if (entry === jsEntry && !existsSync(jsEntry)) {
  process.stderr.write(
    `alchemy: ${jsEntry} has not been built.\n` +
      "Run `pnpm build` in packages/alchemy.\n",
  );
  process.exit(1);
}

// Set for the CLI's React renderer. Children inherit it exactly as they did
// from the spawned child's env; the user's own dev servers get it stripped
// again (see Cloudflare/Workers/ViteChild.ts).
process.env.NODE_ENV = "production";

// The launcher IS the right runtime in two cases, and then simply becomes
// the CLI instead of paying for a second process that only relays signals:
//
//   - node: the loader hooks are ordinary runtime-installable module hooks
//     (`module.registerHooks`); `--import` was only ever a way to run them
//     first. Checkout: register-dev-mode loads .ts/.tsx through Oxc AND
//     resolves the monorepo's own packages (`alchemy/*`, `@alchemy.run/*`,
//     `@distilled.cloud/*`) through their `bun` export condition onto src/,
//     so the CLI, the user's stack, and every workspace dependency load one
//     source universe instead of whatever built lib/ happens to be around.
//     Published: only the Oxc loader, for the user's own .ts/.tsx.
//   - bun on a published install: the bundled `alchemy.js` needs no flags.
//
// Otherwise the CLI must start as bun. On a published install that bun
// needs no flags and prints nothing of its own, so this node launcher (the
// shebang) under `bun run` becomes it in place where node can
// (`process.execve`: POSIX, 22.15+) — same pid, same fds, no relay. A
// checkout instead needs `--tsconfig-override` (below), a flag that makes
// bun print a benign internal warning only a parent can filter, so there —
// and on Windows, and with an IPC channel from a node parent that bun would
// not pick up — bun runs as a foreground child.
if (runtime === "node" || (typeof globalThis.Bun !== "undefined" && !isDev)) {
  if (runtime === "node") {
    await import(
      new URL(
        isDev ? "register-dev-mode.js" : "register-oxc.js",
        import.meta.url,
      ).href
    );
  }
  await import(pathToFileURL(entry).href);
} else {
  const args = [];
  if (isDev) {
    // Pin bun's tsconfig to alchemy's, not whatever happens to be in the
    // invoking workspace's cwd. Bun's default is `$cwd/tsconfig.json` — it
    // does not consult a file's own nearest tsconfig — which means invoking
    // `alchemy` from e.g. `examples/cloudflare-solidstart` would transpile
    // alchemy's own .tsx files with that example's JSX settings
    // (jsx: "preserve", jsxImportSource: "solid-js"), breaking the React
    // files inside the alchemy CLI. Pragmas do not cover it: under a
    // `preserve` tsconfig bun emits `jsxDEV` even in production, which
    // React's production build leaves undefined.
    args.push(
      `--tsconfig-override=${path.join(binDir, "..", "tsconfig.json")}`,
    );
  }
  args.push(entry, ...process.argv.slice(2));
  const bun =
    typeof globalThis.Bun !== "undefined" ? process.execPath : findBun();
  if (
    !isDev &&
    bun !== undefined &&
    typeof process.execve === "function" &&
    process.platform !== "win32" &&
    !process.send
  ) {
    process.execve(bun, ["bun", ...args], process.env);
  }
  // Stderr filter — substring match (not regex), bun may wrap the line in
  // ANSI color codes when stderr is piped to a TTY-aware parent, so anchored
  // regex is fragile. "directory mismatch for directory" is bun's
  // known-benign internal warning triggered by --tsconfig-override
  // (oven-sh/bun#25730): the resolver openat()s the tsconfig basename
  // against a cached dir fd that isn't its parent, falls back to an
  // absolute open, and logs. Bun's own tsconfig-override tests tolerate the
  // same line. Only the checkout path passes --tsconfig-override, which is
  // why published installs never see it.
  foregroundChild(
    bun ?? "bun",
    args,
    (line) => !line.includes("directory mismatch for directory"),
  );
}
