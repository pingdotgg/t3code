#!/usr/bin/env node
// Turns a recording of a live `agy acp` session (one JSON line per frame: {dir: "in"|"out", m})
// into the replay transcript `tools/antigravity-conformance.mjs` plays on both servers:
//
//   node tools/make-antigravity-transcript.mjs <recording.ndjson> > testdata/antigravity/turns.json
//
// The recording must hold: initialize, authenticate, session/new, session/set_config_option,
// one session/prompt with its updates, session/close. The session id becomes a fixed UUID,
// the workspace `<workspace>`. Client frames are expected as `<any>`: the conformance check
// compares what each server writes, the transcript only answers.
import * as NodeFS from "node:fs";

const SESSION = "00000000-0000-4000-8000-00000000a6f1";
const frames = NodeFS.readFileSync(process.argv[2], "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const real = frames.find((f) => f.dir === "in" && f.m.result?.sessionId)?.m.result.sessionId;
const fix = (v) => JSON.parse(JSON.stringify(v).replaceAll(real, SESSION));
const byId = new Map();
for (const f of frames) if (f.dir === "out" && f.m.method) byId.set(f.m.id, f.m.method);
const response = (method) => {
  const out = frames.find((f) => f.dir === "out" && f.m.method === method);
  const reply = frames.find((f) => f.dir === "in" && f.m.id === out.m.id && !f.m.method);
  return { type: "emit_inbound", label: `response:${method}`, frame: { kind: "response", method, result: fix(reply.m.result) } };
};
const expect = (method, params = "<any>") => ({
  type: "expect_outbound",
  label: `request:${method}`,
  frame: { kind: "request", method, params },
});
const promptOut = frames.findIndex((f) => f.dir === "out" && f.m.method === "session/prompt");
const promptId = frames[promptOut].m.id;
const updates = [];
for (const f of frames.slice(promptOut + 1)) {
  if (f.dir === "in" && f.m.id === promptId) break;
  if (f.dir === "in" && f.m.method === "session/update") {
    updates.push({ type: "emit_inbound", label: "notification:session/update", frame: { kind: "notification", method: "session/update", params: fix(f.m.params) } });
  }
}
const turn = () => [expect("session/prompt"), ...updates, response("session/prompt")];
const version = frames.find((f) => f.dir === "in" && f.m.result?.agentInfo)?.m.result.agentInfo.version;
const entries = [
  expect("initialize"),
  response("initialize"),
  expect("authenticate", { methodId: "gemini-api-key" }),
  response("authenticate"),
  expect("session/new"),
  response("session/new"),
  expect("session/set_config_option"),
  response("session/set_config_option"),
  ...turn(),
  ...turn(),
  expect("session/close"),
  response("session/close"),
];
process.stdout.write(
  `${JSON.stringify({ scenario: "turns", metadata: { generatedBy: "make-antigravity-transcript", agyVersion: version, recording: "agy acp, gemini-api-key auth, one prompt 'Reply with exactly: pong' on gemini-3.8-flash; the prompt is replayed for the second turn" }, entries }, null, 1)}\n`,
);
