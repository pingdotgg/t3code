import * as NodeAssert from "node:assert/strict";

import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, it } from "vite-plus/test";

import { makeEventTranslator } from "./OpenCode2Events.ts";

const THREAD = ThreadId.make("thread-opencode2-events");
const TURN = TurnId.make("turn-opencode2-events");
const CREATED = 1_786_000_000_000;

function makeTranslator() {
  let eventCounter = 0;
  return makeEventTranslator({
    newEventId: () => EventId.make(`event-${(eventCounter += 1)}`),
    nowIso: () => "2026-09-29T00:00:00.000Z",
  });
}

function frame(type: string, data: Record<string, unknown>, created: unknown = CREATED) {
  return { id: `evt-${type}`, type, created, data };
}

describe("OpenCode2Events", () => {
  it("maps session.created to thread.started", () => {
    const events = makeTranslator().translate(frame("session.created", { sessionID: "ses_1" }), {
      threadId: THREAD,
      turnId: TURN,
    });
    NodeAssert.equal(events.length, 1);
    const event = events[0]!;
    NodeAssert.equal(event.type, "thread.started");
    NodeAssert.equal(event.threadId, THREAD);
    NodeAssert.equal(event.turnId, TURN);
    NodeAssert.equal(event.provider, "opencode2");
    NodeAssert.deepEqual(event.payload, { providerThreadId: "ses_1" });
    NodeAssert.equal(event.createdAt, "2026-08-06T07:06:40.000Z");
  });

  it("maps session.forked, renamed, metadata, deleted, idle, and status frames", () => {
    const translator = makeTranslator();
    const forked = translator.translate(frame("session.forked", { sessionID: "ses_child" }), {
      threadId: THREAD,
    });
    NodeAssert.equal(forked[0]?.type, "thread.started");

    const renamed = translator.translate(
      frame("session.renamed", { sessionID: "ses_1", title: "New title" }),
      { threadId: THREAD },
    );
    NodeAssert.equal(renamed[0]?.type, "thread.metadata.updated");
    NodeAssert.deepEqual(renamed[0]?.payload, { name: "New title" });

    const metadata = translator.translate(
      frame("session.metadata.updated", { sessionID: "ses_1", metadata: { title: "Meta" } }),
      { threadId: THREAD },
    );
    NodeAssert.equal(metadata[0]?.type, "thread.metadata.updated");

    const blankMetadata = translator.translate(
      frame("session.metadata.updated", { sessionID: "ses_1", metadata: {} }),
      { threadId: THREAD },
    );
    NodeAssert.equal(blankMetadata.length, 0);

    const deleted = translator.translate(frame("session.deleted", { sessionID: "ses_1" }), {
      threadId: THREAD,
    });
    NodeAssert.deepEqual(deleted[0]?.payload, { state: "closed" });

    const busy = translator.translate(
      frame("session.status", { sessionID: "ses_1", status: { type: "busy" } }),
      { threadId: THREAD },
    );
    NodeAssert.deepEqual(busy[0]?.payload, { state: "running" });

    const idleStatus = translator.translate(
      frame("session.status", { sessionID: "ses_1", status: { type: "idle" } }),
      { threadId: THREAD },
    );
    NodeAssert.deepEqual(idleStatus[0]?.payload, { state: "ready" });

    const idle = translator.translate(frame("session.idle", { sessionID: "ses_1" }), {
      threadId: THREAD,
    });
    NodeAssert.deepEqual(idle[0]?.payload, { state: "ready" });
  });

  it("maps execution started/succeeded/interrupted/failed and retry scheduling", () => {
    const translator = makeTranslator();
    const started = translator.translate(frame("session.execution.started", { sessionID: "s" }), {
      threadId: THREAD,
    });
    NodeAssert.equal(started[0]?.type, "turn.started");

    const succeeded = translator.translate(
      frame("session.execution.succeeded", { sessionID: "s" }),
      { threadId: THREAD },
    );
    NodeAssert.deepEqual(succeeded[0]?.payload, { state: "completed" });

    const interrupted = translator.translate(
      frame("session.execution.interrupted", { sessionID: "s", reason: "user" }),
      { threadId: THREAD },
    );
    NodeAssert.equal(interrupted[0]?.type, "turn.aborted");
    NodeAssert.deepEqual(interrupted[0]?.payload, { reason: "user" });

    const failed = translator.translate(
      frame("session.execution.failed", {
        sessionID: "s",
        error: { type: "ProviderError", message: "boom" },
      }),
      { threadId: THREAD },
    );
    NodeAssert.equal(failed[0]?.type, "turn.completed");
    NodeAssert.deepEqual(failed[0]?.payload, { state: "failed", errorMessage: "boom" });

    const retry = translator.translate(
      frame("session.retry.scheduled", {
        sessionID: "s",
        attempt: 2,
        error: { type: "ProviderError", message: "flaky" },
      }),
      { threadId: THREAD },
    );
    NodeAssert.equal(retry[0]?.type, "runtime.warning");
    NodeAssert.equal(retry.length, 1);
    NodeAssert.match(String((retry[0]!.payload as { message: string }).message), /retry 2/);
  });

  it("assembles multi-delta text streams into item.started/content.delta/item.completed", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD, turnId: TURN };
    const started = translator.translate(
      frame("session.text.started", { sessionID: "s", assistantMessageID: "msg_1", ordinal: 0 }),
      context,
    );
    NodeAssert.equal(started[0]?.type, "item.started");
    NodeAssert.deepEqual(started[0]?.payload, {
      itemType: "assistant_message",
      status: "inProgress",
      title: "Assistant message",
    });

    const first = translator.translate(
      frame("session.text.delta", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        ordinal: 0,
        delta: "Hello ",
      }),
      context,
    );
    NodeAssert.equal(first[0]?.type, "content.delta");
    NodeAssert.deepEqual(first[0]?.payload, { streamKind: "assistant_text", delta: "Hello " });

    const second = translator.translate(
      frame("session.text.delta", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        ordinal: 0,
        delta: "world",
      }),
      context,
    );
    NodeAssert.deepEqual(second[0]?.payload, { streamKind: "assistant_text", delta: "world" });

    const ended = translator.translate(
      frame("session.text.ended", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        ordinal: 0,
        text: "Hello world!",
      }),
      context,
    );
    NodeAssert.equal(ended.length, 2);
    NodeAssert.deepEqual(ended[0]?.payload, { streamKind: "assistant_text", delta: "!" });
    NodeAssert.equal(ended[1]?.type, "item.completed");
    NodeAssert.deepEqual(ended[1]?.payload, {
      itemType: "assistant_message",
      status: "completed",
      title: "Assistant message",
      detail: "Hello world!",
    });
  });

  it("keeps reasoning and text ordinals on separate part keys", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD };
    translator.translate(
      frame("session.text.started", { sessionID: "s", assistantMessageID: "msg_1", ordinal: 0 }),
      context,
    );
    const reasoningStart = translator.translate(
      frame("session.reasoning.started", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        ordinal: 0,
      }),
      context,
    );
    NodeAssert.deepEqual(reasoningStart[0]?.payload, {
      itemType: "reasoning",
      status: "inProgress",
      title: "Reasoning",
    });
    const reasoningDelta = translator.translate(
      frame("session.reasoning.delta", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        ordinal: 0,
        delta: "thinking",
      }),
      context,
    );
    NodeAssert.deepEqual(reasoningDelta[0]?.payload, {
      streamKind: "reasoning_text",
      delta: "thinking",
    });
    const ended = translator.translate(
      frame("session.reasoning.ended", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        ordinal: 0,
        text: "thinking",
      }),
      context,
    );
    NodeAssert.equal(ended.length, 1);
    NodeAssert.equal(ended[0]?.type, "item.completed");
  });

  it("streams tool input through to completion with parsed input", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD, turnId: TURN };
    const started = translator.translate(
      frame("session.tool.input.started", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        id: "call_1",
        name: "bash",
      }),
      context,
    );
    NodeAssert.equal(started[0]?.type, "item.started");
    NodeAssert.deepEqual(started[0]?.payload, {
      itemType: "command_execution",
      status: "inProgress",
      title: "bash",
      data: { tool: "bash" },
    });

    const delta = translator.translate(
      frame("session.tool.input.delta", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        id: "call_1",
        delta: '{"comm',
      }),
      context,
    );
    NodeAssert.equal(delta.length, 0);

    const inputEnded = translator.translate(
      frame("session.tool.input.ended", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        id: "call_1",
        text: '{"command":"ls"}',
      }),
      context,
    );
    NodeAssert.equal(inputEnded[0]?.type, "item.updated");
    NodeAssert.equal(inputEnded.length, 1);
    NodeAssert.deepEqual((inputEnded[0]!.payload as { data: unknown }).data, {
      tool: "bash",
      input: { command: "ls" },
    });

    const progress = translator.translate(
      frame("session.tool.progress", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        id: "call_1",
        metadata: { title: "Listing files" },
      }),
      context,
    );
    NodeAssert.equal(progress[0]?.type, "item.updated");

    const success = translator.translate(
      frame("session.tool.success", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        id: "call_1",
        content: [{ type: "text", text: "a.txt" }],
      }),
      context,
    );
    NodeAssert.equal(success[0]?.type, "item.completed");
    NodeAssert.deepEqual(success[0]?.payload, {
      itemType: "command_execution",
      status: "completed",
      title: "Listing files",
      detail: "a.txt",
      data: { tool: "bash", output: "a.txt" },
    });
  });

  it("maps tool failures and tool.called with unknown tool fallback", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD };
    translator.translate(
      frame("session.tool.input.started", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        id: "call_9",
        name: "mystery-widget",
      }),
      context,
    );
    const called = translator.translate(
      frame("session.tool.called", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        id: "call_9",
        input: { foo: "bar" },
      }),
      context,
    );
    NodeAssert.deepEqual(called[0]?.payload, {
      itemType: "dynamic_tool_call",
      status: "inProgress",
      title: "mystery-widget",
      data: { tool: "mystery-widget", input: { foo: "bar" } },
    });
    const failed = translator.translate(
      frame("session.tool.failed", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        id: "call_9",
        error: { type: "ToolError", message: "nope" },
      }),
      context,
    );
    NodeAssert.equal(failed[0]?.type, "item.completed");
    NodeAssert.deepEqual(failed[0]?.payload, {
      itemType: "dynamic_tool_call",
      status: "failed",
      title: "mystery-widget",
      detail: "nope",
      data: { tool: "mystery-widget", error: "nope" },
    });
  });

  it("maps step usage, step failures, compaction, usage chunks, and session errors", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD, turnId: TURN };
    const stepEnded = translator.translate(
      frame("session.step.ended", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      }),
      context,
    );
    NodeAssert.equal(stepEnded[0]?.type, "thread.token-usage.updated");
    NodeAssert.deepEqual(stepEnded[0]?.payload, {
      usage: {
        usedTokens: 21,
        inputTokens: 10,
        cachedInputTokens: 3,
        outputTokens: 5,
        reasoningOutputTokens: 2,
      },
    });

    const stepFailed = translator.translate(
      frame("session.step.failed", {
        sessionID: "s",
        assistantMessageID: "msg_1",
        error: { type: "ProviderError", message: "bad step" },
      }),
      context,
    );
    NodeAssert.equal(stepFailed[0]?.type, "runtime.error");

    const compacted = translator.translate(frame("session.compaction.ended", { sessionID: "s" }), {
      threadId: THREAD,
    });
    NodeAssert.deepEqual(compacted[0]?.payload, { state: "compacted" });

    const usage = translator.translate(
      frame("session.usage.updated", {
        sessionID: "s",
        tokens: { input: 7, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      context,
    );
    NodeAssert.equal(usage[0]?.type, "thread.token-usage.updated");

    const sessionError = translator.translate(
      frame("session.error", {
        sessionID: "s",
        error: { name: "ProviderError", data: { message: "downstream blew up" } },
      }),
      context,
    );
    NodeAssert.equal(sessionError[0]?.type, "runtime.error");
    NodeAssert.deepEqual(sessionError[0]?.payload, {
      message: "downstream blew up",
      class: "provider_error",
      detail: { name: "ProviderError", data: { message: "downstream blew up" } },
    });
  });

  it("maps permission asked/replied to request.opened/request.resolved", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD, turnId: TURN };
    const asked = translator.translate(
      frame("permission.asked", {
        id: "per_1",
        sessionID: "ses_1",
        action: "bash",
        resources: ["ls *"],
      }),
      context,
    );
    NodeAssert.equal(asked[0]?.type, "request.opened");
    NodeAssert.deepEqual(asked[0]?.payload, {
      requestType: "command_execution_approval",
      detail: "ls *",
      options: [
        { decision: "accept", label: "Allow once" },
        {
          decision: "acceptForSession",
          label: "Allow for workspace",
          warning: "Applies to matching requests in other OpenCode sessions in this workspace.",
        },
        { decision: "decline", label: "Deny" },
      ],
    });

    const replied = translator.translate(
      frame("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "once" }),
      context,
    );
    NodeAssert.equal(replied[0]?.type, "request.resolved");
    NodeAssert.deepEqual(replied[0]?.payload, {
      requestType: "command_execution_approval",
      decision: "accept",
    });
  });

  it("maps form created/replied/cancelled to user-input events", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD };
    const created = translator.translate(
      frame("form.created", {
        form: {
          id: "frm_1",
          sessionID: "ses_1",
          title: "Pick",
          fields: [
            {
              key: "color",
              type: "string",
              title: "Color",
              description: "Favorite color?",
              options: [{ value: "red", label: "Red" }],
            },
            {
              key: "tags",
              type: "multiselect",
              title: "Tags",
              options: [{ value: "a", label: "A" }],
            },
          ],
        },
      }),
      context,
    );
    NodeAssert.equal(created[0]?.type, "user-input.requested");
    NodeAssert.equal(created.length, 1);
    const questions = (created[0]!.payload as unknown as { questions: Array<{ id: string }> })
      .questions;
    NodeAssert.deepEqual(
      questions.map((question) => question.id),
      ["color", "tags"],
    );

    const replied = translator.translate(
      frame("form.replied", {
        id: "frm_1",
        sessionID: "ses_1",
        answer: { color: "red", tags: ["a", "b"] },
      }),
      context,
    );
    NodeAssert.equal(replied[0]?.type, "user-input.resolved");
    NodeAssert.deepEqual(replied[0]?.payload, {
      answers: { color: "red", tags: "a, b" },
    });

    translator.translate(
      frame("form.created", {
        form: {
          id: "frm_2",
          sessionID: "ses_1",
          title: "Abort",
          fields: [{ key: "q", type: "string", options: [] }],
        },
      }),
      context,
    );
    const cancelled = translator.translate(
      frame("form.cancelled", { id: "frm_2", sessionID: "ses_1" }),
      context,
    );
    NodeAssert.equal(cancelled[0]?.type, "user-input.resolved");
    NodeAssert.deepEqual(cancelled[0]?.payload, { answers: {} });
  });

  it("maps compaction failure and the deprecated compacted predecessor", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD };
    const failed = translator.translate(
      frame("session.compaction.failed", {
        sessionID: "s",
        reason: "auto",
        error: { type: "CompactionError", message: "nope" },
      }),
      context,
    );
    NodeAssert.equal(failed[0]?.type, "runtime.warning");
    NodeAssert.match(String((failed[0]!.payload as { message: string }).message), /nope/);

    const legacy = translator.translate(frame("session.compacted", { sessionID: "s" }), context);
    NodeAssert.deepEqual(legacy[0]?.payload, { state: "compacted" });
  });

  it("dedupes retry storms to one warning per attempt signature", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD };
    const status = (attempt: number, message: string) =>
      frame("session.status", {
        sessionID: "s",
        status: { type: "retry", attempt, message, next: 5 },
      });
    const first = translator.translate(status(1, "flaky"), context);
    NodeAssert.equal(first.length, 2);
    NodeAssert.equal(first[1]?.type, "runtime.warning");
    // Same attempt+message retried: state still flows, warning is suppressed.
    const second = translator.translate(status(1, "flaky"), context);
    NodeAssert.equal(second.length, 1);
    NodeAssert.equal(second[0]?.type, "session.state.changed");
    // A new attempt re-arms the warning.
    const third = translator.translate(status(2, "flaky"), context);
    NodeAssert.equal(third.length, 2);

    const scheduled = (attempt: number) =>
      frame("session.retry.scheduled", {
        sessionID: "s",
        attempt,
        error: { type: "ProviderError", message: "boom" },
      });
    NodeAssert.equal(translator.translate(scheduled(3), context).length, 1);
    NodeAssert.equal(translator.translate(scheduled(3), context).length, 0);
  });

  it("seeds orphan deltas and completes orphan ended frames", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD };
    // Late subscriber joining mid-stream: no started frame observed.
    const delta = translator.translate(
      frame("session.text.delta", {
        sessionID: "s",
        assistantMessageID: "orphan",
        ordinal: 0,
        delta: "mid-",
      }),
      context,
    );
    NodeAssert.equal(delta[0]?.type, "content.delta");
    const ended = translator.translate(
      frame("session.text.ended", {
        sessionID: "s",
        assistantMessageID: "orphan",
        ordinal: 0,
        text: "mid-stream",
      }),
      context,
    );
    // Suffix math against the seeded prefix emits only the remainder.
    NodeAssert.deepEqual(ended[0]?.payload, {
      streamKind: "assistant_text",
      delta: "stream",
    });
    NodeAssert.equal(ended[1]?.type, "item.completed");

    // Ended frame with no history at all still completes the item.
    const fresh = makeTranslator().translate(
      frame("session.text.ended", {
        sessionID: "s",
        assistantMessageID: "ghost-msg",
        ordinal: 0,
        text: "hello",
      }),
      context,
    );
    NodeAssert.equal(fresh.length, 1);
    NodeAssert.equal(fresh[0]?.type, "item.completed");
    // A repeated ended frame for the same key is a no-op (no duplicate terminal).
    const repeat = translator.translate(
      frame("session.text.ended", {
        sessionID: "s",
        assistantMessageID: "orphan",
        ordinal: 0,
        text: "mid-stream",
      }),
      context,
    );
    NodeAssert.equal(repeat.length, 0);
  });

  it("suppresses rewrite deltas when the final text is not a prefix extension", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD, turnId: TURN };
    translator.translate(
      frame("session.text.started", { sessionID: "s", assistantMessageID: "msg_rw", ordinal: 0 }),
      context,
    );
    translator.translate(
      frame("session.text.delta", {
        sessionID: "s",
        assistantMessageID: "msg_rw",
        ordinal: 0,
        delta: "Hello worl",
      }),
      context,
    );
    // Final text rewrites (rather than extends) the emitted prefix: no
    // content.delta (append-only ingestion would duplicate it), only the
    // terminal event carrying the full text.
    const ended = translator.translate(
      frame("session.text.ended", {
        sessionID: "s",
        assistantMessageID: "msg_rw",
        ordinal: 0,
        text: "Goodbye world",
      }),
      context,
    );
    NodeAssert.equal(ended.length, 1);
    NodeAssert.equal(ended[0]?.type, "item.completed");
    NodeAssert.deepEqual(ended[0]?.payload, {
      itemType: "assistant_message",
      status: "completed",
      title: "Assistant message",
      detail: "Goodbye world",
    });
  });

  it("evicts completed text parts while suppressing duplicate terminals", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD };
    const started = (id: string) =>
      frame("session.text.started", { sessionID: "s", assistantMessageID: id, ordinal: 0 });
    translator.translate(started("msg_evict"), context);
    translator.translate(
      frame("session.text.delta", {
        sessionID: "s",
        assistantMessageID: "msg_evict",
        ordinal: 0,
        delta: "done",
      }),
      context,
    );
    translator.translate(
      frame("session.text.ended", {
        sessionID: "s",
        assistantMessageID: "msg_evict",
        ordinal: 0,
        text: "done",
      }),
      context,
    );
    // Duplicate terminal after eviction: suppressed, never re-seeded as an orphan.
    const repeat = translator.translate(
      frame("session.text.ended", {
        sessionID: "s",
        assistantMessageID: "msg_evict",
        ordinal: 0,
        text: "done",
      }),
      context,
    );
    NodeAssert.equal(repeat.length, 0);
    // A fresh started frame re-arms the key for a new logical part.
    const restarted = translator.translate(started("msg_evict"), context);
    NodeAssert.equal(restarted[0]?.type, "item.started");
    translator.translate(
      frame("session.text.delta", {
        sessionID: "s",
        assistantMessageID: "msg_evict",
        ordinal: 0,
        delta: "again",
      }),
      context,
    );
    const ended = translator.translate(
      frame("session.text.ended", {
        sessionID: "s",
        assistantMessageID: "msg_evict",
        ordinal: 0,
        text: "again",
      }),
      context,
    );
    NodeAssert.equal(ended[0]?.type, "item.completed");
  });

  it("resets text assembly when a completed key restarts", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD };
    const started = (id: string) =>
      frame("session.text.started", { sessionID: "s", assistantMessageID: id, ordinal: 0 });
    translator.translate(started("msg_dup"), context);
    translator.translate(
      frame("session.text.delta", {
        sessionID: "s",
        assistantMessageID: "msg_dup",
        ordinal: 0,
        delta: "first",
      }),
      context,
    );
    translator.translate(
      frame("session.text.ended", {
        sessionID: "s",
        assistantMessageID: "msg_dup",
        ordinal: 0,
        text: "first",
      }),
      context,
    );
    // Retry reuses the key: the new stream must not inherit the old prefix.
    translator.translate(started("msg_dup"), context);
    translator.translate(
      frame("session.text.delta", {
        sessionID: "s",
        assistantMessageID: "msg_dup",
        ordinal: 0,
        delta: "second",
      }),
      context,
    );
    const ended = translator.translate(
      frame("session.text.ended", {
        sessionID: "s",
        assistantMessageID: "msg_dup",
        ordinal: 0,
        text: "second",
      }),
      context,
    );
    NodeAssert.equal(ended.length, 1);
    NodeAssert.equal(ended[0]?.type, "item.completed");
  });

  it("evicts terminal tool calls so duplicate ids start fresh", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD };
    const start = (name: string) =>
      frame("session.tool.input.started", {
        sessionID: "s",
        assistantMessageID: "m",
        id: "call_dup",
        name,
      });
    translator.translate(start("bash"), context);
    translator.translate(
      frame("session.tool.success", {
        sessionID: "s",
        assistantMessageID: "m",
        id: "call_dup",
        content: [{ type: "text", text: "old output" }],
      }),
      context,
    );
    // A duplicate id after the terminal frame is a distinct call: the new
    // start must overwrite the evicted entry, not merge with stale state.
    const restarted = translator.translate(start("edit"), context);
    NodeAssert.deepEqual(restarted[0]?.payload, {
      itemType: "file_change",
      status: "inProgress",
      title: "edit",
      data: { tool: "edit" },
    });
    const failed = translator.translate(
      frame("session.tool.failed", {
        sessionID: "s",
        assistantMessageID: "m",
        id: "call_dup",
        error: { type: "ToolError", message: "new call failed" },
      }),
      context,
    );
    NodeAssert.deepEqual(failed[0]?.payload, {
      itemType: "file_change",
      status: "failed",
      title: "edit",
      detail: "new call failed",
      data: { tool: "edit", error: "new call failed" },
    });
  });

  it("canonicalizes v2 permission actions and routes question to unknown", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD };
    const ask = (action: string, id: string) =>
      translator.translate(
        frame("permission.asked", { id, sessionID: "s", action, resources: ["*"] }),
        context,
      );
    // v2 plugins assert `shell`/`subagent`; v1 asked `bash`/`task`.
    for (const action of ["shell", "bash"]) {
      NodeAssert.deepEqual(ask(action, `perX${action}`)[0]?.payload, {
        requestType: "command_execution_approval",
        detail: action === "bash" ? "bash" : "shell",
        options: (ask("read", "per-opt")[0]!.payload as { options: unknown }).options,
      });
    }
    const subagent = ask("subagent", "per-sub");
    NodeAssert.equal(
      (subagent[0]!.payload as { requestType: string }).requestType,
      "command_execution_approval",
    );
    const task = ask("task", "per-task");
    NodeAssert.equal(
      (task[0]!.payload as { requestType: string }).requestType,
      "command_execution_approval",
    );
    // Read-family actions map to file_read_approval.
    for (const action of ["read", "list"]) {
      const events = ask(action, `perX${action}`);
      NodeAssert.equal(
        (events[0]!.payload as { requestType: string }).requestType,
        "file_read_approval",
      );
    }
    // Edit-family actions map to file_change_approval.
    for (const action of ["edit", "write", "patch"]) {
      const events = ask(action, `perX${action}`);
      NodeAssert.equal(
        (events[0]!.payload as { requestType: string }).requestType,
        "file_change_approval",
      );
    }
    // The question tool resolves via forms, never the approval queue.
    const question = ask("question", "per-q");
    NodeAssert.equal((question[0]!.payload as { requestType: string }).requestType, "unknown");
    // Unknown actions stay unknown (generic "Approval requested") instead
    // of miscategorizing as a command approval.
    const mystery = ask("frobnicate", "per-mystery");
    NodeAssert.equal((mystery[0]!.payload as { requestType: string }).requestType, "unknown");
  });

  it("accepts label-only options and multiple:true question shapes", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD };
    const created = translator.translate(
      frame("form.created", {
        form: {
          id: "frm_q",
          sessionID: "s",
          title: "Ask",
          fields: [
            {
              key: "choice",
              type: "string",
              title: "Pick",
              multiple: true,
              options: [{ label: "Alpha" }, { label: "Beta" }],
            },
          ],
        },
      }),
      context,
    );
    NodeAssert.equal(created[0]?.type, "user-input.requested");
    const questions = created[0]!.payload as unknown as {
      questions: Array<{
        id: string;
        multiSelect?: boolean;
        options: Array<{ label: string; value: string }>;
      }>;
    };
    NodeAssert.equal(questions.questions[0]?.multiSelect, true);
    NodeAssert.deepEqual(
      questions.questions[0]?.options.map((option) => option.value),
      ["Alpha", "Beta"],
    );
  });

  it("drops unknown types and malformed frames without throwing", () => {
    const translator = makeTranslator();
    const context = { threadId: THREAD };
    for (const event of [
      frame("session.moved", { sessionID: "s" }),
      frame("session.usage.recorded", {
        sessionID: "s",
        source: "title",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      frame("session.step.started", { sessionID: "s", assistantMessageID: "m" }),
      frame("pty.updated", { whatever: 1 }),
      frame("pty.created", { info: { id: "pty_1" } }),
      frame("persistent-pty.added", { sessionID: "s", terminal: { id: "t_1" } }),
      frame("session.compaction.started", { sessionID: "s", reason: "auto", recent: "" }),
      frame("session.compaction.delta", { sessionID: "s", text: "x" }),
      frame("session.shell.started", { sessionID: "s", shell: { id: "sh_1" } }),
      frame("session.skill.activated", { sessionID: "s", id: "x", name: "y", text: "z" }),
      frame("session.synthetic", { sessionID: "s", text: "note" }),
      frame("session.revert.staged", { sessionID: "s", revert: {} }),
      frame("provider.updated", {}),
      frame("agent.updated", {}),
      frame("config.updated", {}),
      { id: "evt-x", created: CREATED, data: {} },
      { id: "evt-y", type: "session.created", created: CREATED, data: { nope: true } },
      { id: "evt-z", type: "session.created", created: CREATED, data: "oops" },
      undefined,
      undefined,
      42,
      "session.created",
      frame("session.status", { sessionID: "s", status: { type: "weird" } }),
      frame("session.tool.success", { sessionID: "s", id: "ghost", assistantMessageID: "m" }),
    ]) {
      NodeAssert.deepEqual(translator.translate(event, context), []);
    }
  });

  it("falls back to the injected clock when created is missing", () => {
    // NOTE: `frame()` defaults a missing third arg to CREATED (explicit
    // `undefined` triggers the default), so build the frame literal directly
    // to exercise a genuinely absent `created` timestamp.
    const events = makeTranslator().translate(
      { id: "evt-session.created", type: "session.created", data: { sessionID: "s" } },
      {
        threadId: THREAD,
      },
    );
    NodeAssert.equal(events[0]?.createdAt, "2026-09-29T00:00:00.000Z");
  });

  it("clamps hostile token counts to the safe-integer range", () => {
    const events = makeTranslator().translate(
      frame("session.usage.updated", {
        sessionID: "s",
        tokens: {
          input: 10 ** 19,
          output: 10 ** 19,
          reasoning: 10 ** 19,
          cache: { read: 10 ** 19, write: 10 ** 19 },
        },
      }),
      { threadId: THREAD },
    );
    NodeAssert.equal(events.length, 1);
    NodeAssert.equal(events[0]?.type, "thread.token-usage.updated");
    const first = events[0];
    NodeAssert.ok(first !== undefined);
    const usage = (first.payload as unknown as { usage: Record<string, number> }).usage;
    NodeAssert.ok(
      Number.isSafeInteger(usage["usedTokens"]),
      `usedTokens must stay a safe integer, got ${usage["usedTokens"]}`,
    );
    NodeAssert.equal(usage["usedTokens"], Number.MAX_SAFE_INTEGER);
    NodeAssert.equal(usage["inputTokens"], Number.MAX_SAFE_INTEGER);
  });

  it("floors negative counts to zero and drops non-finite ones", () => {
    const floored = makeTranslator().translate(
      frame("session.usage.updated", {
        sessionID: "s",
        tokens: { input: -5, output: 2.9 },
      }),
      { threadId: THREAD },
    );
    NodeAssert.equal(floored.length, 1);
    const firstFloored = floored[0];
    NodeAssert.ok(firstFloored !== undefined);
    NodeAssert.deepEqual((firstFloored.payload as { usage: Record<string, number> }).usage, {
      usedTokens: 2,
      inputTokens: 0,
      outputTokens: 2,
    });

    const dropped = makeTranslator().translate(
      frame("session.usage.updated", {
        sessionID: "s",
        tokens: { input: Number.NaN, output: Number.POSITIVE_INFINITY },
      }),
      { threadId: THREAD },
    );
    NodeAssert.deepEqual(dropped, []);
  });
});
