import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { T3ThreadReadInput, THREAD_READ_DEFAULT_LIMIT, THREAD_READ_MAX_LIMIT } from "./tools.ts";

const decodeInput = Schema.decodeUnknownEffect(T3ThreadReadInput);

it("decodes a minimal read input with applied defaults", async () => {
  const input = await Effect.runPromise(decodeInput({ threadId: "thread-target" }));
  assert.equal(input.threadId, "thread-target");
  assert.equal(input.afterCreatedAt, undefined);
  assert.equal(input.afterMessageId, undefined);
});

it("rejects out-of-range limits at the schema boundary", async () => {
  await assert.rejects(() => Effect.runPromise(decodeInput({ threadId: "t", limit: 0 })));
  await assert.rejects(() =>
    Effect.runPromise(decodeInput({ threadId: "t", limit: THREAD_READ_MAX_LIMIT + 1 })),
  );
  const capped = await Effect.runPromise(
    decodeInput({ threadId: "t", limit: THREAD_READ_DEFAULT_LIMIT }),
  );
  assert.equal(capped.limit, THREAD_READ_DEFAULT_LIMIT);
});

it("rejects malformed thread ids", async () => {
  await assert.rejects(() => Effect.runPromise(decodeInput({ threadId: "" })));
});
