#!/usr/bin/env node
// A stub ACP agent for the conformance check. A wrapper script runs it as
// `node acp-stub.mjs --stub-config <file> <the client's argv...>`.
//
// It records, to the config's `log` (one JSON line each): its argv, environment and working
// folder; every stdin line exactly as written; the end of stdin; signals. It answers by
// running the T3 server's own replay agent (`apps/server/scripts/acp-replay-agent.ts`) on the
// config's transcript, so the client sees the recorded agent. No real agent starts.
//
// Two processes, so a close is always recorded. Both servers end an ACP agent with SIGKILL to
// its process group right after they end its stdin; a recorder inside that group could die
// before it saw the end of input, and the record would depend on the machine's load.
// - The stub (the client's child, in the client's process group) records its start and the
//   signals it can catch, and starts the worker.
// - The worker runs in a process group of its own, so the client's signals do not reach it.
//   It holds the client's stdin and stdout, records every stdin line and the end of input,
//   runs the replay agent, and writes `worker-exit` last. It ends once stdin ended and the
//   stub is gone (a pipe from the stub closes when the stub dies).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const at = process.argv.indexOf("--stub-config");
const config = JSON.parse(NodeFS.readFileSync(process.argv[at + 1], "utf8"));
const argv = process.argv.slice(at + 2);
// Synchronous appends: each record is on disk before the next event is handled.
const log = (entry) => NodeFS.appendFileSync(config.log, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);

if (process.argv.includes("--stub-worker")) {
  worker();
} else {
  stub();
}

function stub() {
  log({ kind: "start", argv, env: process.env, cwd: process.cwd() });
  const child = NodeChildProcess.spawn(process.execPath, [process.argv[1], "--stub-worker", ...process.argv.slice(2)], {
    detached: true,
    // stdin and stdout pass to the worker; fd 3 tells it when this process is gone.
    stdio: ["inherit", "inherit", "inherit", "pipe"],
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      log({ kind: "signal", signal });
      process.exit(0);
    });
  }
}

function worker() {
  let stdinEnded = false;
  let stubGone = false;
  let agentDone = false;
  const finish = () => {
    if (!(stdinEnded && stubGone && agentDone)) return;
    log({ kind: "worker-exit" });
    process.exit(0);
  };

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
  agent.on("exit", (code) => {
    log({ kind: "agent-exit", code });
    agentDone = true;
    finish();
  });
  forwardAgentOutput(agent);

  const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    log({ kind: "stdin", line });
    agent.stdin.write(`${line}\n`);
  });
  input.on("close", () => {
    // The record comes first: nothing below can delay it.
    log({ kind: "stdin-closed" });
    stdinEnded = true;
    agent.stdin.end();
    finish();
  });

  // The stub's pipe ends when the stub exits or is killed: the agent goes with it.
  const parent = new NodeFS.ReadStream(null, { fd: 3 });
  const parentGone = () => {
    if (stubGone) return;
    stubGone = true;
    // Not compared: it shows whether the end of input came before the signal.
    log({ kind: "stub-gone" });
    if (!agentDone) agent.kill("SIGTERM");
    finish();
  };
  parent.on("data", () => {});
  parent.on("end", parentGone);
  parent.on("error", parentGone);
  parent.on("close", parentGone);
}

// Replay gates (T3's `ProviderReplayGate` across processes): the agent line of a transcript
// entry with a gated label is held, with every line after it, until the test writes
// `<gateDir>/<label>.released`; the worker writes `<label>.reached` when it holds one.
function forwardAgentOutput(agent) {
  const gates = config.gates ?? [];
  if (gates.length === 0) {
    agent.stdout.pipe(process.stdout);
    return;
  }
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
