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
// - A subagent's metadata read (`thread/read` without turns, or `thread/resume` without
//   turns, for a child thread the recording names) is answered `{thread: {id}, model: null}`
//   and logged as `child-metadata`, not `extra`: the TS test kit answers these itself
//   (`withCodexReplayChildMetadata`), so its recordings never hold them.
// - `runtime_exit` marks where the recorded process ended. The stub stops replaying and waits
//   for the client to end it (end of stdin or a signal), so the client's shutdown is
//   recorded. A later start of the stub (a new process) continues after that point; the
//   cursor is kept in `<log>.cursor`.
// - SIGTERM, SIGINT, SIGHUP and the end of stdin are logged (see LINGER_MS below).
// - The replay gate (T3's `makeProviderReplayGate`, used by `release_replay_gate` steps):
//   for each label in `config.gates`, the stub stops before it emits the first recorded
//   frame with that label, writes `<gateDir>/gate-<label>.reached` and waits for
//   `<gateDir>/gate-<label>.release`. Frames the client sends meanwhile wait too.
// - `config.injectItems`: `thread/inject_items` is answered `{}` and logged as `inject`, not
//   `extra`. T3's merge-back test fakes its `injectHistory` the same way, so its recording
//   holds no injection.
// - Probe mode (`config.probes`, for a whole server such as `idle-diff.mjs`): a provider status
//   probe's own app-server process is answered from canned replies and moves no cursor. See
//   `PROBE_REPLIES` below. `config.version` answers `codex --version`.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const configIndex = process.argv.indexOf("--stub-config");
const config = JSON.parse(NodeFS.readFileSync(process.argv[configIndex + 1], "utf8"));
const argv = process.argv.slice(configIndex + 2);
const log = (entry) =>
  NodeFS.appendFileSync(config.log, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...entry })}\n`);

// `config.logEnv: false` keeps the environment out of the log (a check that needs no env diff).
log({ kind: "start", argv, env: config.logEnv === false ? undefined : { ...process.env }, cwd: process.cwd(), pid: process.pid });

// Text generation (`CodexTextGeneration.ts`) runs short CLI commands, not the app-server:
// - `mcp list --json` prints `config.mcpServers` (default: none);
// - `exec … -` reads the prompt on stdin, records it and the `--output-schema` file, and
//   writes `config.execOutput` (default `{"title":"Stub title"}`) to `--output-last-message`.
// `--version` (T3's `probeCodexCliVersion`) prints `config.version` when the config names one;
// otherwise the stub stays silent, as before.
if (argv[0] === "--version" && typeof config.version === "string") {
  process.stdout.write(`codex-cli ${config.version}\n`);
  process.exit(0);
}
if (argv.includes("mcp") && argv.includes("list")) {
  log({ kind: "mcp-list" });
  process.stdout.write(JSON.stringify(config.mcpServers ?? []));
  process.exit(0);
}
if (argv[0] === "exec") {
  const after = (flag) => argv[argv.indexOf(flag) + 1];
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const schemaPath = after("--output-schema");
    log({
      kind: "exec",
      stdin: Buffer.concat(chunks).toString("utf8"),
      schema: NodeFS.readFileSync(schemaPath, "utf8"),
      schemaName: schemaPath.split("/").at(-1).length,
      schemaDir: schemaPath.split("/").at(-2).replace(/[A-Za-z0-9]{6}$/, "XXXXXX"),
    });
    NodeFS.writeFileSync(after("--output-last-message"), config.execOutput ?? '{"title":"Stub title"}');
    process.exit(config.execExit ?? 0);
  });
} else {

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
// `withCodexReplayChildMetadata`: the child threads the recording names.
const childThreadIds = new Set(
  entries.flatMap((entry) => {
    const item = entry.type === "emit_inbound" ? entry.frame?.params?.item : undefined;
    if (item?.type === "subAgentActivity" && typeof item.agentThreadId === "string") {
      return [item.agentThreadId];
    }
    return item?.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((id) => typeof id === "string")
      : [];
  }),
);
const isChildMetadataRead = (frame) => {
  const params = frame.params ?? {};
  return (
    (frame.method === "thread/read" ? params.includeTurns === false : frame.method === "thread/resume" && params.excludeTurns === true) &&
    typeof params.threadId === "string" &&
    childThreadIds.has(params.threadId)
  );
};
const cursorFile = `${config.log}.cursor`;
let cursor = NodeFS.existsSync(cursorFile) ? Number(NodeFS.readFileSync(cursorFile, "utf8")) : 0;
let ended = false;
// The replay gate: labels not yet released, the label the stub is held at, and the frames
// that came in while it was held.
const gates = new Set(config.gates ?? []);
let held = null;
const heldFrames = [];
const gateFile = (label, state) =>
  `${config.gateDir}/gate-${encodeURIComponent(label)}.${state}`;
const saveCursor = () => NodeFS.writeFileSync(cursorFile, String(cursor));
// recorded request id -> id the client used
const responseIds = new Map();

// `normalizeLegacyInboundFrame` in the TS replay driver: older recordings lack fields that
// newer CLIs send; both servers get the same upgraded frames.
const upgrade = (value) => {
  if (Array.isArray(value)) return value.map(upgrade);
  if (typeof value !== "object" || value === null) return value;
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, upgrade(v)]));
  if (typeof out.id === "string" && "modelProvider" in out && "status" in out) {
    if (out.sessionId === undefined) out.sessionId = out.id;
    if (out.projectId === undefined) out.projectId = null;
  }
  const params = typeof out.params === "object" && out.params !== null ? { ...out.params } : undefined;
  if (params !== undefined && typeof out.method === "string") {
    if (out.method === "item/started" && params.startedAtMs === undefined) params.startedAtMs = 0;
    if (out.method === "item/completed" && params.completedAtMs === undefined) params.completedAtMs = 0;
    if (out.method.endsWith("/requestApproval") && params.startedAtMs === undefined) params.startedAtMs = 0;
    if (out.method === "item/tool/requestUserInput" && params.isBlocking === undefined) params.isBlocking = true;
    out.params = params;
  }
  return out;
};

const send = (frame) => {
  process.stdout.write(`${JSON.stringify(upgrade(frame))}\n`);
};

const hold = (label) => {
  held = label;
  NodeFS.writeFileSync(gateFile(label, "reached"), "");
  log({ kind: "gate-reached", label });
  const poll = setInterval(() => {
    if (!NodeFS.existsSync(gateFile(label, "release"))) return;
    clearInterval(poll);
    gates.delete(label);
    held = null;
    log({ kind: "gate-released", label });
    emitUntilExpectation();
    saveCursor();
    while (held === null && heldFrames.length > 0) onFrame(heldFrames.shift());
  }, 5);
};

const emitUntilExpectation = () => {
  while (cursor < entries.length && entries[cursor].type !== "expect_outbound") {
    const entry = entries[cursor];
    if (entry.type === "emit_inbound" && gates.has(entry.label)) {
      hold(entry.label);
      return;
    }
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
      // Probe mode answered this request already, before it knew the process replays.
      if (answeredIds.delete(frame.id)) continue;
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
    // A subagent's child thread: the TS test kit answers these reads itself
    // (`withCodexReplayChildMetadata`); the stub answers the same way.
    case "thread/read":
      return { thread: { id: params.threadId }, model: null };
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
  // Answered the same before and after the recorded end: when it comes is timing.
  if (frame.id !== undefined && isChildMetadataRead(frame)) {
    log({ kind: "child-metadata", frame });
    send({ id: frame.id, result: { thread: { id: frame.params.threadId }, model: null } });
    return;
  }
  if (held !== null) {
    heldFrames.push(frame);
    return;
  }
  if (ended) {
    // Past the recorded end: answer requests with an empty result so the client is not left
    // waiting on its request timeout.
    log({ kind: "after-exit", frame });
    if (frame.method !== undefined && frame.id !== undefined) send({ id: frame.id, result: {} });
    return;
  }
  if (config.injectItems === true && frame.method === "thread/inject_items" && frame.id !== undefined) {
    log({ kind: "inject", frame });
    send({ id: frame.id, result: {} });
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

// Probe mode (`config.probes`): a server's provider status probe (T3's
// `probeCodexAppServerProvider`) starts its own `codex app-server` and sends `initialize`, then
// `account/read`. That process must not move the replay cursor. So the stub answers
// `initialize` at once with the first recorded reply and holds the frames until the first
// other request: `account/read` makes the process a probe, answered with canned replies and
// logged as `probe`; anything else replays the held frames (the recorded `initialize` reply is
// not sent twice).
const PROBE_REPLIES = {
  "account/read": { account: { type: "apiKey" }, requiresOpenaiAuth: false },
  "skills/list": { data: [] },
  "model/list": { data: [], nextCursor: null },
  "config/read": { config: {}, origins: {} },
};
const answeredIds = new Set();
let mode = config.probes ? "undecided" : "replay";
const undecided = [];
const recordedInitialize = entries.find(
  (entry) => entry.type === "emit_inbound" && entry.label === "initialize" && entry.frame?.result !== undefined,
)?.frame.result;
const onInput = (frame) => {
  if (mode === "replay") return onFrame(frame);
  if (mode === "probe") {
    log({ kind: "probe", method: frame.method ?? "<reply>" });
    if (frame.method !== undefined && frame.id !== undefined) {
      send({ id: frame.id, result: PROBE_REPLIES[frame.method] ?? {} });
    }
    return;
  }
  if (frame.method === "initialize" || frame.method === "initialized" || frame.method === undefined) {
    undecided.push(frame);
    if (frame.method === "initialize" && frame.id !== undefined) {
      answeredIds.add(frame.id);
      send({ id: frame.id, result: recordedInitialize ?? {} });
    }
    return;
  }
  if (frame.method === "account/read") {
    mode = "probe";
    log({ kind: "probe", method: "initialize" });
    onInput(frame);
    return;
  }
  mode = "replay";
  emitUntilExpectation();
  for (const early of undecided.splice(0)) onFrame(early);
  onFrame(frame);
};

if (mode === "replay") emitUntilExpectation();
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
  onInput(frame);
});
lines.on("close", () => beginShutdown("stdin-end"));
}
