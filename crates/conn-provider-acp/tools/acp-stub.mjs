#!/usr/bin/env node
// A stub ACP agent for the conformance check. A wrapper script runs it as
// `node acp-stub.mjs --stub-config <file> <the client's argv...>`.
//
// It records, to the config's `log` (one JSON line each): its argv, environment and working
// folder; every stdin line exactly as written; the end of stdin; signals. It answers by
// running the T3 server's own replay agent (`apps/server/scripts/acp-replay-agent.ts`) on the
// config's transcript, so the client sees the recorded agent. No real agent starts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const at = process.argv.indexOf("--stub-config");
const config = JSON.parse(NodeFS.readFileSync(process.argv[at + 1], "utf8"));
const argv = process.argv.slice(at + 2);
const log = (entry) => NodeFS.appendFileSync(config.log, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);

log({ kind: "start", argv, env: process.env, cwd: process.cwd() });

const agent = NodeChildProcess.spawn(process.execPath, [config.replayAgent], {
  env: {
    ...process.env,
    T3_ACP_REPLAY_TRANSCRIPT_PATH: config.transcript,
    T3_ACP_REPLAY_STATUS_PATH: config.status,
    // The workspace as the recording's `<workspace>` stands for it: the config's, when the
    // caller knows the path as the server wrote it (a temp folder can differ from its real path).
    T3_ACP_REPLAY_WORKSPACE: config.workspace ?? process.cwd(),
  },
  stdio: ["pipe", "pipe", "inherit"],
});
agent.stdout.pipe(process.stdout);
agent.on("exit", (code) => {
  log({ kind: "agent-exit", code });
  process.exit(code ?? 0);
});

const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  log({ kind: "stdin", line });
  agent.stdin.write(`${line}\n`);
});
input.on("close", () => {
  log({ kind: "stdin-closed" });
  agent.stdin.end();
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    log({ kind: "signal", signal });
    agent.kill("SIGTERM");
    process.exit(0);
  });
}
