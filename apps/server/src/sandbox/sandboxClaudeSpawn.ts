// @effect-diagnostics nodeBuiltinImport:off - the Claude SDK spawn hook must return a Node child process.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import type { SandboxExecTarget } from "./SandboxService.ts";

const SCRIPT_RUNTIMES = new Set(["node", "bun", "deno"]);

/**
 * `spawnClaudeCodeProcess` for a sandboxed worktree. The SDK passes the
 * host's Claude executable, which may be a macOS binary; the image's own
 * `claude` (pinned to the host version) runs instead with the same arguments.
 */
export const sandboxClaudeSpawn =
  (target: SandboxExecTarget) =>
  (options: SpawnOptions): SpawnedProcess => {
    const runtime = NodePath.basename(options.command).replace(/\.exe$/, "");
    const args =
      SCRIPT_RUNTIMES.has(runtime) && /\.(c|m)?js$/.test(options.args[0] ?? "")
        ? options.args.slice(1)
        : options.args;
    const command = target.command({
      command: "claude",
      args,
      cwd: options.cwd ?? target.worktreePath,
      env: options.env,
      tty: false,
    });
    const child = NodeChildProcess.spawn(command.command, [...command.args], {
      env: command.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    });
    child.once("exit", command.release);
    child.once("error", command.release);
    return child;
  };
