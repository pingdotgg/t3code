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
// Replay gates (T3's `ProviderReplayGate` across processes): the agent line of a transcript
// entry with a gated label is held, with every line after it, until the test writes
// `<gateDir>/<label>.released`; the stub writes `<label>.reached` when it holds one.
const gates = config.gates ?? [];
if (gates.length === 0) {
  agent.stdout.pipe(process.stdout);
} else {
  const gateFile = (label, kind) => `${config.gateDir}/${encodeURIComponent(label)}.${kind}`;
  const entries = JSON.parse(NodeFS.readFileSync(config.transcript, "utf8")).entries;
  let index = 0;
  try {
    index = JSON.parse(NodeFS.readFileSync(config.status, "utf8")).cursor ?? 0;
  } catch {
    // A first process starts at the beginning.
  }
  let holding = null;
  const held = [];
  const output = NodeReadline.createInterface({ input: agent.stdout, crlfDelay: Infinity });
  output.on("line", (line) => {
    while (index < entries.length && entries[index].type !== "emit_inbound") index += 1;
    const label = entries[index]?.label;
    index += 1;
    if (holding === null && gates.includes(label) && !NodeFS.existsSync(gateFile(label, "released"))) {
      holding = label;
      NodeFS.writeFileSync(gateFile(label, "reached"), "");
    }
    if (holding === null) process.stdout.write(`${line}\n`);
    else held.push(line);
  });
  setInterval(() => {
    if (holding === null || !NodeFS.existsSync(gateFile(holding, "released"))) return;
    holding = null;
    for (const line of held.splice(0)) process.stdout.write(`${line}\n`);
  }, 5).unref();
}
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
