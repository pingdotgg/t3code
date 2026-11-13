#!/usr/bin/env node
// A stand-in for the `codex` executable, for conformance runs. It records its argv, its
// environment, its working folder and every line it gets on stdin, and replays a recorded
// `app-server` transcript (`codex_transcript.ndjson`, or the JSON form the TS harness decodes).
//
// Started through a wrapper script that `conformance.mjs` writes:
//   exec node codex-stub.mjs --stub-config <config.json> "$@"
// The config names the transcript and the log file, so the stub adds nothing to the
// environment of the process it stands in for.
//
// Replay rules (looser than the TS replay driver on purpose, so a difference is recorded and
// the run goes on):
// - Inbound frames before the first `expect_outbound` go out at start.
// - Each stdin frame is matched to the next `expect_outbound` with the same method (a reply
//   matches a reply). Skipped expectations are logged as `missing`. After a match, the
//   `emit_inbound` frames up to the next expectation go out, with response ids rewritten to
//   the id the client used.
// - A request that matches nothing gets a canned answer (`model/list`) or a -32601 error, and
//   is logged as `extra`.
// - `runtime_exit` marks where the recorded process ended. The stub stops replaying and waits
//   for the client to end it (end of stdin or a signal), so the client's shutdown is
//   recorded. A later start of the stub (a new process) continues after that point; the
//   cursor is kept in `<log>.cursor`.
// - SIGTERM, SIGINT, SIGHUP and the end of stdin are logged (see LINGER_MS below).
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const configIndex = process.argv.indexOf("--stub-config");
const config = JSON.parse(NodeFS.readFileSync(process.argv[configIndex + 1], "utf8"));
const argv = process.argv.slice(configIndex + 2);
const log = (entry) =>
  NodeFS.appendFileSync(config.log, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);

log({ kind: "start", argv, env: { ...process.env }, cwd: process.cwd(), pid: process.pid });

const readTranscript = (path) => {
  const text = NodeFS.readFileSync(path, "utf8");
  if (text.trimStart().startsWith("{\"type\":\"transcript_start\"") || path.endsWith(".ndjson")) {
    const lines = text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    return lines.filter((entry) => entry.type !== "transcript_start");
  }
  return JSON.parse(text).entries;
};

const entries = readTranscript(config.transcript);
const cursorFile = `${config.log}.cursor`;
let cursor = NodeFS.existsSync(cursorFile) ? Number(NodeFS.readFileSync(cursorFile, "utf8")) : 0;
let ended = false;
const saveCursor = () => NodeFS.writeFileSync(cursorFile, String(cursor));
// recorded request id -> id the client used
const responseIds = new Map();

const send = (frame) => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const emitUntilExpectation = () => {
  while (cursor < entries.length && entries[cursor].type !== "expect_outbound") {
    const entry = entries[cursor];
    cursor += 1;
    if (entry.type === "runtime_exit") {
      log({ kind: "runtime_exit", status: entry.status ?? null });
      ended = true;
      saveCursor();
      return;
    }
    if (entry.type !== "emit_inbound") continue;
    const frame = { ...entry.frame };
    delete frame.emittedAtMs;
    if (frame.method === undefined && frame.id !== undefined && responseIds.has(frame.id)) {
      frame.id = responseIds.get(frame.id);
    }
    send(frame);
  }
};

const kindOf = (frame) =>
  frame.method !== undefined ? frame.method : frame.id !== undefined ? "<reply>" : "<invalid>";

const canned = (frame) => {
  const params = frame.params ?? {};
  switch (frame.method) {
    case "model/list":
      return { data: [], nextCursor: null };
    case "config/read":
      return { config: {}, origins: {} };
    // A thread reload (a model change on the TS side) or a resume the recording lacks.
    case "thread/resume":
      return {
        thread: { id: params.threadId, createdAt: 0, updatedAt: 0, turns: [] },
        model: params.model ?? null,
      };
    case "thread/unsubscribe":
    case "thread/unarchive":
    case "thread/inject_items":
    case "thread/backgroundTerminals/terminate":
      return {};
    default:
      return undefined;
  }
};

const onFrame = (frame) => {
  if (ended) {
    // Past the recorded end: answer requests with an empty result so the client is not left
    // waiting on its request timeout.
    log({ kind: "after-exit", frame });
    if (frame.method !== undefined && frame.id !== undefined) send({ id: frame.id, result: {} });
    return;
  }
  const kind = kindOf(frame);
  let match = -1;
  for (let i = cursor; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.type === "expect_outbound" && kindOf(entry.frame) === kind) {
      // A reply matches only the reply with the same server request id.
      if (kind === "<reply>" && entry.frame.id !== frame.id) continue;
      match = i;
      break;
    }
  }
  if (match === -1) {
    log({ kind: "extra", frame });
    if (frame.method !== undefined && frame.id !== undefined) {
      const result = canned(frame);
      send(
        result === undefined
          ? { id: frame.id, error: { code: -32601, message: `stub: ${frame.method} is not in the transcript` } }
          : { id: frame.id, result },
      );
    }
    return;
  }
  for (let i = cursor; i < match; i += 1) {
    if (entries[i].type === "expect_outbound") log({ kind: "missing", expected: entries[i].frame });
  }
  const expected = entries[match].frame;
  if (frame.method !== undefined && frame.id !== undefined && expected.id !== undefined) {
    responseIds.set(expected.id, frame.id);
  }
  cursor = match + 1;
  emitUntilExpectation();
  saveCursor();
};

// Shutdown is recorded, not obeyed at once: after the end of stdin or a signal the stub stays
// up for LINGER_MS, logging each signal with its delay since the first one, then exits. A
// client that force-kills leaves no `linger-exit` entry; `conformance.mjs` reads that as killed.
const LINGER_MS = config.lingerMs ?? 4000;
let shutdownAt;
const beginShutdown = (kind) => {
  const now = Date.now();
  if (shutdownAt === undefined) {
    shutdownAt = now;
    // A heartbeat bounds when a SIGKILL landed: the last `alive` entry before it.
    setInterval(() => log({ kind: "alive", afterMs: Date.now() - shutdownAt }), 100);
    setTimeout(() => {
      log({ kind: "linger-exit", afterMs: Date.now() - shutdownAt });
      process.exit(0);
    }, LINGER_MS);
  }
  log({ kind, afterMs: now - shutdownAt });
};
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => beginShutdown(signal));
}

emitUntilExpectation();
const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    log({ kind: "in", line, invalid: true });
    return;
  }
  log({ kind: "in", frame });
  onFrame(frame);
});
lines.on("close", () => beginShutdown("stdin-end"));
