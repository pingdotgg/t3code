#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

// Transparent CLI observer: retain only user text blocks, never env, auth, or control frames.
const executable = process.env.T3_CLAUDE_OBSERVER_EXECUTABLE;
const rawOutput = process.env.T3_CLAUDE_OBSERVER_OUTPUT;
// Resolve first so `/tmp/../elsewhere` cannot pass the prefix check.
const output = rawOutput ? NodePath.resolve(rawOutput) : undefined;
if (!executable || !output?.startsWith("/tmp/")) {
  throw new Error("Set T3_CLAUDE_OBSERVER_EXECUTABLE and /tmp T3_CLAUDE_OBSERVER_OUTPUT");
}
const child = NodeChildProcess.spawn(executable, process.argv.slice(2), {
  stdio: ["pipe", "inherit", "inherit"],
});
// One decoder across chunks, so a multibyte character split between reads stays intact.
const decoder = new NodeStringDecoder.StringDecoder("utf8");
let pending = "";
function record(text) {
  pending += text;
  const lines = pending.split("\n");
  pending = lines.pop();
  for (const line of lines) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value.type !== "user") continue;
    const blocks = value.message?.content;
    const texts =
      typeof blocks === "string"
        ? [blocks]
        : blocks?.filter((b) => b.type === "text").map((b) => b.text);
    // `mode` only applies on create; fchmod also tightens a log that already existed.
    const fd = NodeFS.openSync(output, "a", 0o600);
    try {
      NodeFS.fchmodSync(fd, 0o600);
      NodeFS.writeSync(
        fd,
        JSON.stringify({ at: new Date().toISOString(), pid: process.pid, texts }) + "\n",
      );
    } finally {
      NodeFS.closeSync(fd);
    }
  }
}
process.stdin.on("data", (chunk) => {
  // Stop reading while the child is behind, so a slow reader cannot grow our buffer unbounded.
  if (!child.stdin.write(chunk)) {
    process.stdin.pause();
    child.stdin.once("drain", () => process.stdin.resume());
  }
  record(decoder.write(chunk));
});
process.stdin.on("end", () => {
  child.stdin.end();
  record(decoder.end() + "\n");
});
const forward = (signal) => child.kill(signal);
process.on("SIGTERM", forward);
process.on("SIGINT", forward);
child.on("exit", (code, signal) => {
  if (code !== null) process.exit(code);
  // Mirror the child's signal death; drop our forwarders first so the self-signal is not caught.
  process.off("SIGTERM", forward);
  process.off("SIGINT", forward);
  process.kill(process.pid, signal);
  // Node ignores some signals (SIGPIPE), so still exit if the self-signal did not end us.
  process.exit(1);
});
