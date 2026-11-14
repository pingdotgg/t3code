#!/usr/bin/env node
// Stands between the Claude provider and the fake SDK host of the Claude transcript replay
// (crates/conn-provider-claude/tools/t3-replay/fake-host.mjs), for the engine replay.
//
//   node claude-session-shim.mjs <recorded session id> <fake-host.mjs> <transcript> <result.json>
//
// T3's replay harness pins the Claude session id to the recording's
// (`allocateSessionId: nativeSessionIdFor(transcript)` in ClaudeAdapterV2.testkit.ts). Our
// provider picks a random one when it makes the thread, and the engine gives no way to pin it.
// So the shim learns our id from the first `open` and rewrites every line: ours to the
// recorded id towards the host, the recorded id to ours towards the provider. Nothing else
// changes, so every other byte the provider sends is still compared with the recording.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { createInterface } from "node:readline";

const [recorded, fakeHost, ...hostArgs] = process.argv.slice(2);
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
