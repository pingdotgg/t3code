#!/usr/bin/env node
// A stub `grok` CLI for the status probe check (tools/probe-conformance.mjs). A wrapper script
// runs it as `node grok-cli-stub.mjs --stub-config <file> <the caller's argv...>`.
//
// It records, to the config's `log` (one JSON line each): its argv, environment and working
// folder; every stdin line; the end of stdin; signals; its own exit. It answers per the
// config's behaviour for `--version`, `models` (one entry per call, the last repeats),
// `inspect --json` and `agent ... stdio` (ACP: answers `initialize`, or fails, or hangs).
// No real CLI runs and nothing leaves the machine.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const at = process.argv.indexOf("--stub-config");
const config = JSON.parse(NodeFS.readFileSync(process.argv[at + 1], "utf8"));
const argv = process.argv.slice(at + 2);
const log = (entry) => NodeFS.appendFileSync(config.log, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);

log({ kind: "start", argv, env: process.env, cwd: process.cwd() });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    log({ kind: "signal", signal, argv });
    if (!current?.ignoreTerm) process.exit(0);
  });
}

const behaviour = config.behaviour ?? {};
let current;

const answer = (spec) => {
  current = spec ?? { code: 0, stdout: "" };
  if (current.hang) {
    // Stays until killed; SIGTERM is logged and, with ignoreTerm, ignored.
    setInterval(() => {}, 1 << 30);
    return;
  }
  if (current.stdout) process.stdout.write(current.stdout);
  if (current.stderr) process.stderr.write(current.stderr);
  process.exitCode = current.code ?? 0;
};

const count = (name) => {
  const file = `${config.log}.${name}.count`;
  const n = NodeFS.existsSync(file) ? Number(NodeFS.readFileSync(file, "utf8")) : 0;
  NodeFS.writeFileSync(file, String(n + 1));
  return n;
};

if (argv[0] === "--version") {
  answer(behaviour.version);
} else if (argv[0] === "models") {
  const calls = behaviour.models ?? [{ code: 0, stdout: "" }];
  const n = count("models");
  answer(calls[Math.min(n, calls.length - 1)]);
} else if (argv[0] === "inspect") {
  answer(behaviour.inspect);
} else if (argv.includes("agent") && argv.at(-1) === "stdio") {
  const agent = behaviour.agent ?? { mode: "ok", initialize: { protocolVersion: 1 } };
  current = { ignoreTerm: agent.ignoreTerm };
  if (agent.mode === "exit") {
    process.exitCode = agent.code ?? 1;
  } else {
    setInterval(() => {}, 1 << 30);
    const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on("line", (line) => {
      log({ kind: "stdin", line });
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (frame.method !== "initialize" || agent.mode === "hang") return;
      const reply =
        agent.mode === "error"
          ? { jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: "stub failure" } }
          : { jsonrpc: "2.0", id: frame.id, result: agent.initialize };
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
    input.on("close", () => log({ kind: "stdin-closed" }));
  }
} else {
  process.stderr.write(`grok stub: unknown command ${JSON.stringify(argv)}\n`);
  process.exitCode = 2;
}
