#!/usr/bin/env node
// A fake SDK host for the T3 transcript replay. It speaks the host protocol
// (helpers/sdk-host/PROTOCOL.md) and replays one of the T3 server's own Claude transcripts
// (apps/server/src/orchestration-v2/testkit/fixtures/*/claude_transcript.ndjson): `emit_inbound`
// frames go to the Rust session, and every `expect_outbound` frame must match what the session
// sends, projected the way T3's ClaudeAdapterV2.testkit.ts projects its query runner calls.
//
//   node fake-host.mjs <transcript> <result.json>
//
// The result file gets {cursor, total, done, mismatch?} when the host exits.
//
// The replay gate (T3's makeProviderReplayGate, for the engine's fixture replay): when the
// transcript's folder holds `gates/labels.json`, an inbound entry whose label is listed waits
// there. The host writes `gates/reached-<index>` and goes on once `gates/released-<index>`
// exists. Without the folder nothing waits.

import * as fs from "node:fs";
import { createInterface } from "node:readline";

const [transcriptPath, resultPath] = process.argv.slice(2);
const entries = fs
  .readFileSync(transcriptPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((e) => e.type !== "transcript_start");
// The real host stops when its last session ends and starts again for the next one; the
// replay goes on where the previous fake host stopped.
const previous = (() => {
  try {
    return JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } catch {
    return null;
  }
})();
let cursor = previous?.mismatch == null ? (previous?.cursor ?? 0) : 0;
let mismatch = previous?.mismatch ?? null;
let session = null; // {sessionId, driver, instanceId}
const pendingRequests = new Map(); // our request id → expected answer
let nextRequest = 0;
const promptUuids = new Map(previous?.promptUuids ?? []); // recorded uuid → actual

const gateDir = `${transcriptPath.replace(/[^/]*$/, "")}gates`;
const gateLabels = (() => {
  try {
    return JSON.parse(fs.readFileSync(`${gateDir}/labels.json`, "utf8"));
  } catch {
    return [];
  }
})();
let gateTimer = null;
/** True when the entry must wait at its gate; pump runs again once it is released. */
function heldAtGate(entry) {
  const index = gateLabels.indexOf(entry.label);
  if (index === -1 || fs.existsSync(`${gateDir}/released-${index}`)) return false;
  fs.writeFileSync(`${gateDir}/reached-${index}`, "");
  if (gateTimer === null) {
    gateTimer = setInterval(() => {
      if (!fs.existsSync(`${gateDir}/released-${index}`)) return;
      clearInterval(gateTimer);
      gateTimer = null;
      pump();
    }, 5);
  }
  return true;
}

const write = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const save = () =>
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      { cursor, total: entries.length, done: cursor >= entries.length, mismatch, promptUuids: [...promptUuids] },
      null,
      1,
    ),
  );

// T3's sameFrame: deep equality of JSON values.
const canon = (v) =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
      : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// stableClaudeQueryOptions in ClaudeAdapterV2.testkit.ts.
function stableOptions(o) {
  const stable = {
    model: o.model,
    tools: o.tools,
    permissionMode: o.permissionMode,
    ...(o.allowedTools === undefined ? {} : { allowedTools: o.allowedTools }),
    ...(o.disallowedTools === undefined ? {} : { disallowedTools: o.disallowedTools }),
    ...(o.settings === undefined ? {} : { settings: o.settings }),
    ...(o.allowDangerouslySkipPermissions === true ? { allowDangerouslySkipPermissions: true } : {}),
    ...(o.resumeSessionAt === undefined ? {} : { resumeSessionAt: o.resumeSessionAt }),
    ...(o.forkSession === true ? { forkSession: true } : {}),
  };
  return o.resume === undefined ? { ...stable, sessionId: o.sessionId } : { ...stable, resume: o.resume };
}

function withoutUuid(frame) {
  if (frame?.type !== "prompt.offer" || frame.message?.uuid === undefined) return frame;
  const { uuid: _u, ...message } = frame.message;
  return { ...frame, message };
}

/** Matches the next transcript entry against an outbound frame. */
function expect(actual, { continueReplay = true } = {}) {
  if (mismatch !== null) return false;
  const entry = entries[cursor];
  if (entry?.type !== "expect_outbound") {
    mismatch = { cursor, expected: entry ?? "end of transcript", actual };
    finish();
    return false;
  }
  if (!same(withoutUuid(entry.frame), withoutUuid(actual))) {
    mismatch = { cursor, label: entry.label, expected: entry.frame, actual };
    finish();
    return false;
  }
  const recorded = entry.frame.message?.uuid;
  const actualUuid = actual.message?.uuid;
  if (typeof recorded === "string" && typeof actualUuid === "string") promptUuids.set(recorded, actualUuid);
  cursor++;
  if (continueReplay) pump();
  return true;
}

// Prompt uuids differ on replay; rewrite echoes (as the T3 testkit does).
function withReplayedUuids(frame) {
  const map = (u) => promptUuids.get(u) ?? u;
  const out = { ...frame };
  if (typeof out.user_message_uuid === "string") out.user_message_uuid = map(out.user_message_uuid);
  if (Array.isArray(out.user_message_uuids)) out.user_message_uuids = out.user_message_uuids.map(map);
  if (typeof out.command_uuid === "string") out.command_uuid = map(out.command_uuid);
  return out;
}

let ended = false;
function finish(error) {
  if (session === null || ended) return;
  ended = true;
  save();
  write({ ch: "sdk", t: "end", ...session, ...(error ? { error: { message: error } } : {}) });
  save();
}

/** Emits inbound entries until the next expected outbound frame. */
function pump() {
  if (session === null || ended) return;
  while (cursor < entries.length && mismatch === null) {
    const entry = entries[cursor];
    if (entry.type === "expect_outbound") return;
    if (entry.type === "emit_inbound" && heldAtGate(entry)) return;
    cursor++;
    if (entry.type === "runtime_exit") {
      // A process exit; the next expected frame (if any) is a new query.open.
      finish(entry.status === "success" ? undefined : String(entry.error ?? "exit"));
      return;
    }
    if (entry.type !== "emit_inbound") continue;
    const frame = entry.frame;
    if (frame.type === "permission.request") {
      const id = `perm-${++nextRequest}`;
      pendingRequests.set(id, true);
      write({
        ch: "sdk",
        t: "request",
        ...session,
        id,
        kind: "canUseTool",
        args: { toolName: frame.toolName, input: frame.input, options: { ...frame.options, requestId: id } },
      });
      return; // wait for the response
    }
    if (frame.type === "session.forked" || frame.type === "subagent.found") continue;
    write({ ch: "sdk", t: "msg", ...session, m: withReplayedUuids(frame) });
  }
  if (cursor >= entries.length) finish();
}

const reply = (id, value) => write({ ch: "reply", id, ok: true, value: value ?? null });

createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line);
  switch (cmd.t) {
    case "open":
      session = { driver: cmd.driver, instanceId: cmd.instanceId, sessionId: cmd.sessionId };
      ended = false;
      expect({ type: "query.open", options: stableOptions(cmd.options) });
      break;
    case "input":
      reply(cmd.id);
      expect({ type: "prompt.offer", message: cmd.message });
      break;
    case "call":
      reply(cmd.id, cmd.method === "setMcpServers" ? { added: [], removed: [], errors: {} } : null);
      if (cmd.method === "interrupt") expect({ type: "query.interrupt" });
      else if (cmd.method === "setModel") expect({ type: "query.set_model", model: cmd.args[0] });
      else if (cmd.method === "setPermissionMode")
        expect({ type: "query.set_permission_mode", mode: cmd.args[0] });
      break;
    case "response":
      if (pendingRequests.delete(cmd.id)) {
        // T3 records the PermissionResult its canUseTool returned.
        expect({ type: "permission.response", result: cmd.value ?? {} });
      }
      break;
    case "fn":
      if (cmd.name === "forkSession") {
        const [sessionId, options] = cmd.args;
        const ok = expect({ type: "session.fork", sessionId, options: options ?? {} }, { continueReplay: false });
        let forked = null;
        if (ok && entries[cursor]?.frame?.type === "session.forked") {
          forked = entries[cursor].frame.sessionId;
          cursor++;
        }
        reply(cmd.id, forked === null ? null : { sessionId: forked });
        pump();
      } else {
        reply(cmd.id, cmd.name === "resolveSettings" ? { effective: {}, provenance: {}, sources: [] } : null);
      }
      break;
    case "close":
      finish();
      break;
    case "shutdown":
      save();
      process.exit(0);
  }
});
process.stdin.on("end", () => {
  save();
  process.exit(0);
});
write({ ch: "host", t: "ready", protocol: 1, node: process.versions.node });
