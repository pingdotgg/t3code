import assert from "node:assert/strict";
import { test } from "node:test";
import WebSocket from "ws";
import { rename, rm, writeFile } from "node:fs/promises";
import type { Session } from "../../../packages/protocol/src/index.ts";
import { app, TOKEN } from "./app.ts";

test("Android pairing accepts its loopback origin and rejects a wrong credential or unrelated origin", async (t) => {
  const mobile = await app(t);
  assert.deepEqual(await mobile.client.request({ method: "sessions/list" }), []);
  for (const [token, origin] of [["b".repeat(64), `http://127.0.0.1:${mobile.port}`], [TOKEN, "https://unrelated.example"]]) {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${mobile.port}/rpc`, ["t3mobile", `token.${token}`], { origin });
      socket.on("unexpected-response", (_, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
      socket.on("error", reject);
      socket.on("open", () => { socket.close(); reject(Error("Invalid pairing accepted")); });
    });
    assert.equal(status, 401);
  }
});

test("a prompt streams an assistant response, command output, and changes into the mobile session", async (t) => {
  const mobile = await app(t);
  const session = await mobile.create();
  assert.equal(session.fullAccess, false);
  await mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Stream response" } });
  await mobile.wait(() => mobile.sessions.get(session.id)?.messages.some((m) => m.text === "The project ") === true, "partial assistant response");
  await mobile.finishResponse();
  await mobile.wait(() => mobile.sessions.get(session.id)?.status === "idle", "completed response");
  const result = mobile.sessions.get(session.id)!;
  assert.deepEqual(result.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Stream response" }, { role: "assistant", text: "The project is ready." },
  ]);
  assert.equal(result.tools[0]?.output, "working tree clean\n");
  assert.equal(result.tools[0]?.status, "completed");
  assert.equal(result.diff, "--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n");
  assert.equal(result.turnId, null);
});

test("an approval blocks work until the mobile user answers it", async (t) => {
  const mobile = await app(t);
  const session = await mobile.create();
  await mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Wait for approval" } });
  await mobile.wait(() => mobile.sessions.get(session.id)?.approvals.length === 1, "command approval");
  const pending = mobile.sessions.get(session.id)!;
  assert.equal(pending.status, "running");
  assert.equal(pending.approvals[0]?.detail, "git status");
  await mobile.client.request({ method: "approval/respond", params: { sessionId: session.id, requestId: pending.approvals[0]!.id, decision: "decline" } });
  await mobile.wait(() => mobile.sessions.get(session.id)?.status === "idle", "declined command finishes");
  assert.equal(mobile.sessions.get(session.id)?.messages.at(-1)?.text, "Command declined.");
  assert.deepEqual(mobile.sessions.get(session.id)?.approvals, []);
});

test("the mobile user can answer an agent question and continue the turn", async (t) => {
  const mobile = await app(t);
  const session = await mobile.create();
  await mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Ask which target" } });
  await mobile.wait(() => mobile.sessions.get(session.id)?.questions.length === 1, "agent question");
  const question = mobile.sessions.get(session.id)!.questions[0]!;
  assert.equal(question.questions[0]?.question, "Which target?");
  await mobile.client.request({ method: "question/respond", params: { sessionId: session.id, requestId: question.id, answers: { target: ["Android"] } } });
  await mobile.wait(() => mobile.sessions.get(session.id)?.status === "idle", "answered turn finishes");
  assert.equal(mobile.sessions.get(session.id)?.messages.at(-1)?.text, "Selected Android.");
  assert.deepEqual(mobile.sessions.get(session.id)?.questions, []);
});

test("Stop interrupts active work and another prompt cannot overlap it", async (t) => {
  const mobile = await app(t);
  const session = await mobile.create();
  await mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Keep working" } });
  await assert.rejects(mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Start duplicate work" } }), /active turn/);
  await mobile.client.request({ method: "turn/interrupt", params: { sessionId: session.id } });
  await mobile.wait(() => mobile.sessions.get(session.id)?.status === "interrupted", "Stop completes");
  assert.equal(mobile.sessions.get(session.id)?.turnId, null);
  assert.equal(mobile.sessions.get(session.id)?.messages.length, 1);
  await mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Summarize project" } });
  await mobile.wait(() => mobile.sessions.get(session.id)?.status === "idle", "new work after Stop");
  assert.equal(mobile.sessions.get(session.id)?.messages.at(-1)?.text, "The project is ready.");
});

test("a crashed Codex process reports failure and the next prompt can recover", async (t) => {
  const mobile = await app(t);
  const session = await mobile.create();
  await mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Crash provider" } });
  await mobile.wait(() => mobile.sessions.get(session.id)?.status === "error", "provider failure");
  assert.match(mobile.sessions.get(session.id)!.error!, /Codex exited/);
  assert.equal(mobile.sessions.get(session.id)?.turnId, null);
  await mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Summarize project" } });
  await mobile.wait(() => mobile.sessions.get(session.id)?.status === "idle", "recovered response");
  assert.equal(mobile.sessions.get(session.id)?.messages.at(-1)?.text, "The project is ready.");
});

test("restart restores a conversation and also keeps untouched sessions usable", async (t) => {
  const mobile = await app(t);
  const used = await mobile.create();
  const empty = await mobile.create();
  await mobile.client.request({ method: "turn/start", params: { sessionId: used.id, text: "Summarize project" } });
  await mobile.wait(() => mobile.sessions.get(used.id)?.status === "idle", "first response");
  await mobile.stopBackend();
  await mobile.restartBackend();
  assert.equal(mobile.sessions.get(used.id)?.messages.at(-1)?.text, "The project is ready.");
  assert.deepEqual(mobile.sessions.get(empty.id)?.messages, []);
  for (const session of [used, empty]) {
    await mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Summarize project" } });
    await mobile.wait(() => mobile.sessions.get(session.id)?.status === "idle", "response after restart");
    assert.equal(mobile.sessions.get(session.id)?.messages.at(-1)?.text, "The project is ready.");
  }
});

test("a disconnect rejects an uncertain prompt and reconnect restores it without replaying work", async (t) => {
  const mobile = await app(t);
  const session = await mobile.create();
  const rejected = assert.rejects(mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Delay start acknowledgement" } }), /Connection lost/);
  await mobile.wait(() => typeof mobile.sessions.get(session.id)?.turnId === "string", "provider started before acknowledgement");
  await mobile.stopBackend();
  await rejected;
  await mobile.restartBackend();
  const restored = mobile.sessions.get(session.id)!;
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.turnId, null);
  assert.deepEqual(restored.messages.map((m) => m.text), ["Delay start acknowledgement"]);
  // A new prompt must be accepted, so a reconnect cannot have started the old work again.
  await mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Summarize project" } });
  await mobile.wait(() => mobile.sessions.get(session.id)?.status === "idle", "explicit continuation");
  assert.deepEqual(mobile.sessions.get(session.id)?.messages.filter((m) => m.role === "user").map((m) => m.text), ["Delay start acknowledgement", "Summarize project"]);
});

test("a storage failure after Codex starts keeps Stop available and prevents overlapping work", async (t) => {
  const mobile = await app(t);
  const session = await mobile.create();
  const started = mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Wait before acknowledgement" } });
  await mobile.wait(() => typeof mobile.sessions.get(session.id)?.turnId === "string", "active provider turn");
  await rename(mobile.directory, mobile.directory + ".backup");
  await writeFile(mobile.directory, "storage temporarily unavailable");
  try {
    await mobile.acknowledgeStart();
    const result = await started as Session;
    assert.equal(result.status, "running");
    assert.equal(typeof result.turnId, "string");
    await mobile.wait(() => mobile.events.some((e) => "event" in e && e.event === "runtime/error" && e.message.includes("Cannot save sessions")), "visible storage error");
    await assert.rejects(mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Duplicate work" } }), /active turn/);
    await mobile.client.request({ method: "turn/interrupt", params: { sessionId: session.id } });
    await mobile.wait(() => mobile.sessions.get(session.id)?.status === "interrupted", "Stop despite storage failure");
  } finally {
    await rm(mobile.directory); await rename(mobile.directory + ".backup", mobile.directory);
  }
});

test("a storage failure before starting leaves no unsent prompt and the session can recover after restart", async (t) => {
  const mobile = await app(t);
  const session = await mobile.create();
  await rename(mobile.directory, mobile.directory + ".backup");
  await writeFile(mobile.directory, "storage temporarily unavailable");
  try {
    await assert.rejects(mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "This prompt must not run" } }), /ENOTDIR/);
    const sessions = await mobile.client.request({ method: "sessions/list" }) as Session[];
    assert.deepEqual(sessions.find((s) => s.id === session.id)?.messages, []);
    assert.equal(sessions.find((s) => s.id === session.id)?.turnId, null);
  } finally {
    await rm(mobile.directory); await rename(mobile.directory + ".backup", mobile.directory);
  }
  await mobile.stopBackend();
  await mobile.restartBackend();
  await mobile.client.request({ method: "turn/start", params: { sessionId: session.id, text: "Summarize project" } });
  await mobile.wait(() => mobile.sessions.get(session.id)?.status === "idle", "response after storage recovery");
  assert.deepEqual(mobile.sessions.get(session.id)?.messages.map((m) => m.text), ["Summarize project", "The project is ready."]);
});
