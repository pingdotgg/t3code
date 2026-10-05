#!/usr/bin/env node
// @ts-check

import { spawn } from "node:child_process";
import { accessSync, existsSync, constants as fsConstants } from "node:fs";
import * as NodeModule from "node:module";
import { constants } from "node:os";
import { pathToFileURL } from "node:url";
import path from "pathe";

NodeModule.enableCompileCache?.();

const binDir = path.dirname(import.meta.filename);
const entry = path.join(binDir, "alchemy.js");
const isDev = !(
  binDir.includes("/node_modules/") || binDir.includes("\\node_modules\\")
);

const execpath = (process.env.npm_execpath ?? "").toLowerCase();
const userAgent = (process.env.npm_config_user_agent ?? "").toLowerCase();

const runningInBun =
  // @ts-ignore
  "Bun" in globalThis && typeof globalThis.Bun !== "undefined";

const runtime =
  runningInBun || execpath.includes("bun") || userAgent.startsWith("bun/")
    ? "bun"
    : "node";

if (runtime === "node") {
  // Oxc's loader requires module.registerHooks. Keep this gate in sync with
  // src/Util/Node.ts; the launcher must run before TypeScript can be loaded.
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const supportsHooks =
    (major === 22 && minor >= 15) ||
    (major === 23 && minor >= 5) ||
    major >= 24;
  if (!supportsHooks) {
    process.stderr.write(
      `alchemy: node ${process.versions.node} is not supported ` +
        "(module.registerHooks needs node 22.15+, 23.5+, or 24+).\n" +
        "Use a newer node, or run alchemy with bun.\n",
    );
    process.exit(1);
  }

  process.env.NODE_ENV = "production";
  const loader = isDev ? "register-dev-mode.js" : "register-oxc.js";
  await import(new URL(loader, import.meta.url).href);
  await import(pathToFileURL(entry).href);
} else {
  // Bun always loads source. Start a child so its JSX settings are established
  // before loading the CLI, independent of the caller's tsconfig.
  const tsconfig = path.join(binDir, isDev ? ".." : ".", "tsconfig.json");
  const bun = runningInBun ? process.execPath : (findBun() ?? "bun");
  const args = [
    `--tsconfig-override=${tsconfig}`,
    entry,
    ...process.argv.slice(2),
  ];

  process.env.NODE_ENV = "production";
  // Bun's tsconfig override can emit this benign diagnostic (oven-sh/bun#25730).
  // Keep the parent to filter it and forward signals, IPC and exit status.
  foregroundChild(
    bun,
    args,
    (line) => !line.includes("directory mismatch for directory"),
  );
}

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
function foregroundChild(program, args, stderrFilter) {
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
}

/**
 * The bun executable, as an absolute path, or `undefined` when it cannot be
 * found. `bun run` names itself in `npm_execpath`; otherwise walk `PATH`.
 *
 * @returns {string | undefined}
 */
function findBun() {
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
}
