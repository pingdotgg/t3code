#!/usr/bin/env node
// Stands between the Claude provider and the fake SDK host of the Claude transcript replay
// (crates/conn-provider-claude/tools/t3-replay/fake-host.mjs), for the engine replay.
//
//   node claude-session-shim.mjs [--task-root <dir>] <recorded session id> <fake-host.mjs> <transcript> <result.json>
//
// T3's replay harness pins the Claude session id to the recording's
// (`allocateSessionId: nativeSessionIdFor(transcript)` in ClaudeAdapterV2.testkit.ts). Our
// provider picks a random one when it makes the thread, and the engine gives no way to pin it.
// So the shim learns our id from the first `open` and rewrites every line: ours to the
// recorded id towards the host, the recorded id to ours towards the provider. Nothing else
// changes, so every other byte the provider sends is still compared with the recording.
//
// With --task-root, it writes each foreground Bash call's recorded output to the file Claude
// Code writes for its task, as T3's harness does (writeReplayTaskOutputFiles in
// ClaudeAdapterV2.testkit.ts): <root>/claude-<uid>/replay-project/<session>/tasks/<task>.output,
// under our session id, since the provider reads the id from the (mapped) task_started frame.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
let taskRoot = null;
if (argv[0] === "--task-root") {
  taskRoot = argv[1];
  argv.splice(0, 2);
}
const [recorded, fakeHost, ...hostArgs] = argv;

const writeTaskFiles = (sessionId) => {
  if (taskRoot === null) return;
  const frames = NodeFS.readFileSync(hostArgs[0], "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
    .flatMap((entry) => (entry.type === "emit_inbound" && entry.frame ? [entry.frame] : []));
  const outputs = new Map();
  for (const frame of frames) {
    const result = frame.tool_use_result;
    const content = frame.message?.content;
    if (typeof result?.stdout !== "string" || !Array.isArray(content)) continue;
    const block = content.find((b) => b?.type === "tool_result" && typeof b.tool_use_id === "string");
    if (block === undefined) continue;
    outputs.set(block.tool_use_id, result.stdout + (typeof result.stderr === "string" ? result.stderr : ""));
  }
  const root = `${taskRoot}/claude-${process.getuid()}`;
  for (const frame of frames) {
    if (frame.type !== "system" || frame.subtype !== "task_started") continue;
    if (frame.task_type !== "local_bash" || frame.is_backgrounded !== false) continue;
    const output = outputs.get(frame.tool_use_id);
    if (output === undefined) continue;
    const tasks = `${root}/replay-project/${sessionId}/tasks`;
    NodeFS.mkdirSync(tasks, { recursive: true });
    NodeFS.writeFileSync(`${tasks}/${String(frame.task_id)}.output`, output);
  }
};
const host = NodeChildProcess.spawn(process.execPath, [fakeHost, ...hostArgs], {
  stdio: ["pipe", "pipe", "inherit"],
});
// The host stops after the last session and starts again for the next; the id we learned
// stays in a file beside the host's result (its last argument).
const stateFile = `${hostArgs.at(-1)}.session-id`;
let ours = NodeFS.existsSync(stateFile) ? NodeFS.readFileSync(stateFile, "utf8") : null;

const swap = (line, from, to) => (from === null || from === to ? line : line.split(from).join(to));

createInterface({ input: process.stdin }).on("line", (line) => {
  if (ours === null) {
    try {
      const command = JSON.parse(line);
      if (command.t === "open" && typeof command.options?.sessionId === "string") {
        ours = command.options.sessionId;
        NodeFS.writeFileSync(stateFile, ours);
        writeTaskFiles(ours);
      }
    } catch {}
  }
  host.stdin.write(`${swap(line, ours, recorded)}\n`);
});
process.stdin.on("end", () => host.stdin.end());
createInterface({ input: host.stdout }).on("line", (line) => {
  process.stdout.write(`${swap(line, recorded, ours)}\n`);
});
host.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => host.kill(signal));
}
