import type {
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess as ClaudeSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import * as NodeChildProcess from "node:child_process";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { claudeCliEnvironment, type ClaudeAccountDir } from "./ClaudeHome.ts";

const CLAUDE_GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

/** Kill leftover MCP children on CLI exit; the watcher also stops the group if the server crashes. */
export function spawnClaudeProcess(
  options: ClaudeSpawnOptions,
  platform: NodeJS.Platform,
  configDir?: ClaudeAccountDir,
  onExit?: () => void,
  onStderr?: (chunk: string) => void,
): ClaudeSpawnedProcess {
  const child = NodeChildProcess.spawn(
    platform === "win32" ? options.command : "/bin/sh",
    platform === "win32"
      ? options.args
      : ["-c", CLAUDE_GROUP_WATCH_SCRIPT, "t3-claude", options.command, ...options.args],
    {
      cwd: options.cwd,
      env: configDir === undefined ? options.env : claudeCliEnvironment(options.env, configDir),
      signal: options.signal,
      stdio: platform === "win32" ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
      detached: platform !== "win32",
      windowsHide: true,
    },
  );
  child.stderr?.setEncoding("utf8").on("data", onStderr ?? (() => {}));
  child.once("exit", () => {
    onExit?.();
    if (platform === "win32") return;
    try {
      signalProcessGroup(child.pid ?? 0, "SIGKILL");
    } catch {}
  });
  // Node's typings make stdin and stdout nullable once stdio has a fourth entry; both are pipes.
  return child as ClaudeSpawnedProcess;
}
