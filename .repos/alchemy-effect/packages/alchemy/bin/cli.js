#!/usr/bin/env node
// @ts-check

import { spawn } from "node:child_process";
import * as NodeModule from "node:module";
import { pathToFileURL } from "node:url";
import * as SemVer from "effect/SemVer";
import * as SemVerRange from "effect/SemVerRange";
import path from "pathe";

const binDir = path.dirname(import.meta.filename);
const entry = path.join(binDir, "alchemy.js");
const args = process.argv.slice(2);

// Alchemy's own TSX carries `@jsxRuntime automatic` pragmas and sigil's
// jsx-dev-runtime is the production runtime, so Bun's startup JSX choice
// (from the caller's tsconfig and NODE_ENV) cannot break the CLI. NODE_ENV
// still names the mode for everything else.
process.env.NODE_ENV = "production";

/**
 * `bun run`/`bunx` start a node-shebang bin under Node but always point
 * npm_execpath at bun. npm_config_user_agent only names the package-manager
 * role (e.g. nub reports `bun/<v>` for a bun project while running Node).
 */
const launchedByBun = () => path.basename(process.env.npm_execpath ?? "").startsWith("bun");

/**
 * `execve` needs a Node that has it and a platform that does (not Windows),
 * and must not sever an IPC channel a parent holds to this process.
 */
const canReplaceProcess = () =>
  process.platform !== "win32" && process.execve !== undefined && process.send === undefined;

if (typeof globalThis.Bun !== "undefined") {
  await runUnderBun();
} else if (launchedByBun()) {
  handOffToBun();
} else {
  await runUnderNode();
}

/** Already running under bun: nothing to set up. */
async function runUnderBun() {
  await import(pathToFileURL(entry).href);
}

/**
 * Started by bun as a package manager: run the CLI under bun, as asked.
 * `npm_execpath` is the bun binary itself. Where possible this process is
 * replaced outright (same pid, fds and process group, so the terminal's
 * signals and the exit status are the CLI's own); otherwise the CLI runs as
 * a child sharing this terminal.
 */
function handOffToBun() {
  const bun = /** @type {string} */ (process.env.npm_execpath);
  const bunArgs = [entry, ...args];
  try {
    if (canReplaceProcess()) {
      process.execve(bun, [bun, ...bunArgs], process.env);
    } else {
      runAsChild(bun, bunArgs);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`alchemy: could not start ${bun}: ${message}\n`);
    process.exit(1);
  }
}

/**
 * Run `program` as a foreground child: signals, IPC messages and the exit
 * status (or signal) are forwarded so the parent cannot tell the difference.
 *
 * @param {string} program
 * @param {ReadonlyArray<string>} programArgs
 */
function runAsChild(program, programArgs) {
  const child = spawn(program, programArgs, {
    stdio: process.send ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
  });
  child.on("error", (error) => {
    process.stderr.write(`alchemy: could not start ${program}: ${error.message}\n`);
    process.exit(1);
  });

  /** @type {Array<NodeJS.Signals>} */
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"];
  for (const signal of signals) process.on(signal, () => child.kill(signal));

  if (process.send) {
    const serializable = /** @param {unknown} message */ (message) =>
      /** @type {import("node:child_process").Serializable} */ (message);
    child.on("message", (message, handle) => process.send?.(serializable(message), handle));
    process.on("message", (message, handle) => child.send(serializable(message), handle));
    process.on("disconnect", () => child.disconnect());
  }

  child.on("close", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

/**
 * Plain Node: check the version, install the Oxc TypeScript loader, then
 * run the CLI. A checkout (outside node_modules) runs from `src/` with the
 * dev-mode hooks; a published install runs its built `lib/`.
 */
async function runUnderNode() {
  if (!supportsModuleHooks()) {
    process.stderr.write(
      `alchemy: node ${process.versions.node} is not supported. ` +
        "Upgrade to node 22.22.3, 24.11.1 or newer.\n",
    );
    process.exit(1);
  }
  NodeModule.enableCompileCache?.();
  // `--fast-distilled` opts in to distilled's lazy service stubs (see
  // register-oxc.js). The env var carries the choice to the loader and to
  // every Node child alchemy starts with it (dev exec child, sidecar).
  // Flags after a `--` separator belong to someone else.
  const separator = args.indexOf("--");
  if ((separator === -1 ? args : args.slice(0, separator)).includes("--fast-distilled")) {
    process.env.ALCHEMY_FAST_DISTILLED = "1";
  }
  const isCheckout = !(binDir.includes("/node_modules/") || binDir.includes("\\node_modules\\"));
  const register = isCheckout ? "register-dev-mode.js" : "register-oxc.js";
  await import(new URL(register, import.meta.url).href);
  await import(pathToFileURL(entry).href);
}

/**
 * Oxc's loader needs complete `module.registerHooks` support: 24.11.1 and
 * 25.1 carry the load-step fix for imported CommonJS (nodejs/node#59929).
 * Keep this in sync with `isRegisterHooksSupported` in src/Util/Node.ts; the
 * launcher must run before any TypeScript can be loaded.
 */
function supportsModuleHooks() {
  return SemVerRange.matches(
    SemVerRange.parseUnsafe(">=22.22.3 <23.0.0-0 || >=24.11.1 <25.0.0-0 || >=25.1.0"),
    SemVer.parseUnsafe(process.versions.node),
    { includePrerelease: true },
  );
}
