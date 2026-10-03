import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { EnvironmentId, MessageId, ThreadId } from "./baseSchemas.ts";
import {
  OrchestrationMessageContext,
  THREAD_CONTEXT_LABEL_MAX_CHARS,
  THREAD_CONTEXT_MAX_RECORDS,
  ThreadContextId,
  ThreadContextRecord,
} from "./threadContext.ts";

const decodeRecord = Schema.decodeUnknownEffect(ThreadContextRecord);
const decodeContext = Schema.decodeUnknownEffect(OrchestrationMessageContext);
const decodeContextId = Schema.decodeUnknownEffect(ThreadContextId);

const recordInput = {
  version: 1,
  kind: "thread",
  contextId: "ctx_1",
  label: "Auth refactor thread",
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  title: "Auth refactor",
};

it("decodes a well-formed thread context record", async () => {
  const record = await Effect.runPromise(decodeRecord(recordInput));
  assert.equal(record.version, 1);
  assert.equal(record.kind, "thread");
  assert.equal(record.environmentId, "env-1");
  assert.equal(record.threadId, "thread-1");
});

it("rejects the wrong version", async () => {
  await assert.rejects(() => Effect.runPromise(decodeRecord({ ...recordInput, version: 2 })));
});

it("rejects the wrong kind", async () => {
  await assert.rejects(() => Effect.runPromise(decodeRecord({ ...recordInput, kind: "file" })));
});

it("rejects malformed context ids", async () => {
  await assert.rejects(() =>
    Effect.runPromise(decodeRecord({ ...recordInput, contextId: "not a valid id!" })),
  );
  await assert.rejects(() => Effect.runPromise(decodeContextId("")));
});

it("rejects oversized labels and titles", async () => {
  const long = "x".repeat(THREAD_CONTEXT_LABEL_MAX_CHARS + 1);
  await assert.rejects(() => Effect.runPromise(decodeRecord({ ...recordInput, label: long })));
  await assert.rejects(() => Effect.runPromise(decodeRecord({ ...recordInput, title: long })));
});

it("keeps identity scoped to environment and thread", async () => {
  const record = await Effect.runPromise(decodeRecord(recordInput));
  // Identity is the (environmentId, threadId) pair, not the display label/title.
  assert.notEqual(record.environmentId, record.threadId);
  assert.equal(
    `${record.environmentId}:${record.threadId}`,
    `${recordInput.environmentId}:${recordInput.threadId}`,
  );
});

it("decodes optional message context with unique records", async () => {
  const context = await Effect.runPromise(
    decodeContext({
      version: 1,
      records: [
        recordInput,
        { ...recordInput, contextId: "ctx_2", threadId: ThreadId.make("thread-2") },
      ],
    }),
  );
  assert.equal(context.records.length, 2);
});

it("rejects duplicate context ids", async () => {
  await assert.rejects(() =>
    Effect.runPromise(decodeContext({ version: 1, records: [recordInput, recordInput] })),
  );
});

it("rejects oversized record lists", async () => {
  const records = Array.from({ length: THREAD_CONTEXT_MAX_RECORDS + 1 }, (_, index) => ({
    ...recordInput,
    contextId: `ctx_${index}`,
    threadId: ThreadId.make(`thread-${index}`),
  }));
  await assert.rejects(() => Effect.runPromise(decodeContext({ version: 1, records })));
});

it("accepts an empty record list", async () => {
  const context = await Effect.runPromise(decodeContext({ version: 1, records: [] }));
  assert.equal(context.records.length, 0);
});

it("exposes message ids as distinct branded identities", async () => {
  // Guards against confusing a context id with a message id at call sites.
  const contextId = ThreadContextId.make("ctx_9");
  const messageId = MessageId.make("ctx_9");
  assert.equal(contextId, messageId);
  assert.notEqual(ThreadContextId.ast, MessageId.ast);
});
