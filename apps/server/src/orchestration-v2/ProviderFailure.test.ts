import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
  MAX_PROVIDER_FAILURE_CODE_LENGTH,
  MAX_PROVIDER_FAILURE_MESSAGE_LENGTH,
} from "./ProviderFailure.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";

it("redacts credentials and URL secrets from provider failures", () => {
  const failure = makeProviderFailure({
    message:
      'request failed: Authorization: Bearer bearer-secret https://user:pass@example.test/path?access_token=url-secret#fragment {"token":"json-secret"} api_key=key-secret sk-abcdefghijklmnop',
    code: "provider_rejected",
    class: "provider_error",
  });

  assert.equal(failure.class, "provider_error");
  assert.equal(failure.code, "provider_rejected");
  assert.include(failure.message, "[REDACTED]");
  assert.include(failure.message, "https://example.test/path");
  assert.notInclude(failure.message, "bearer-secret");
  assert.notInclude(failure.message, "user:pass");
  assert.notInclude(failure.message, "url-secret");
  assert.notInclude(failure.message, "json-secret");
  assert.notInclude(failure.message, "key-secret");
  assert.notInclude(failure.message, "sk-abcdefghijklmnop");
});

it("replaces unsafe control characters without stripping whitespace", () => {
  const failure = makeProviderFailure({ message: "before\u0000\u0007\t\nafter\u007f" });

  assert.equal(failure.message, "before  \t\nafter");
});

it("bounds provider-controlled failure strings", () => {
  const failure = makeProviderFailure({
    message: "m".repeat(MAX_PROVIDER_FAILURE_MESSAGE_LENGTH + 500),
    code: "c".repeat(MAX_PROVIDER_FAILURE_CODE_LENGTH + 50),
  });

  assert.equal(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  assert.equal(failure.code?.length, MAX_PROVIDER_FAILURE_CODE_LENGTH);
  assert.match(failure.message, /…$/u);
  assert.match(failure.code ?? "", /…$/u);
});

it("does not split a surrogate pair at the truncation boundary", () => {
  const failure = makeProviderFailure({
    message: `${"a".repeat(MAX_PROVIDER_FAILURE_MESSAGE_LENGTH - 2)}🚀tail`,
  });

  assert.equal(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH - 1);
  assert.equal(failure.message.at(-1), "…");
  assert.notMatch(failure.message.slice(0, -1), /[\uD800-\uDBFF]$/u);
});

it("does not serialize arbitrary provider causes", () => {
  const failure = makeProviderFailure({
    cause: {
      payload: { authorization: "Bearer nested-secret" },
      stack: "private provider stack",
    },
    class: "transport_error",
  });

  assert.deepEqual(failure, {
    class: "transport_error",
    message: "Provider turn failed.",
    code: null,
    retryable: null,
  });
});

it.effect("keys terminal failure items by provider turn across retries and fallback paths", () =>
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocatorV2;
    const driver = ProviderDriverKind.make("codex");
    const runId = RunId.make("run:provider-failure-id");
    const base = {
      idAllocator,
      driver,
      threadId: ThreadId.make("thread:provider-failure-id"),
      runId,
      nodeId: NodeId.make("node:provider-failure-id"),
      providerThreadId: ProviderThreadId.make("provider-thread:provider-failure-id"),
      itemOrdinal: 101,
      failure: makeProviderFailure({ message: "Provider failed" }),
      occurredAt: DateTime.makeUnsafe("2026-06-22T12:00:00.000Z"),
    } as const;
    const firstTurnId = ProviderTurnId.make("provider-turn:provider-failure-id:first");
    const secondTurnId = ProviderTurnId.make("provider-turn:provider-failure-id:second");

    const firstAttempt = makeProviderFailureTurnItem({
      ...base,
      providerTurnId: firstTurnId,
    });
    const retriedAttempt = makeProviderFailureTurnItem({
      ...base,
      providerTurnId: secondTurnId,
    });
    const ingestorFallback = makeProviderFailureTurnItem({
      ...base,
      runId: null,
      nodeId: null,
      providerTurnId: firstTurnId,
    });

    assert.notEqual(firstAttempt.id, retriedAttempt.id);
    assert.equal(firstAttempt.id, ingestorFallback.id);
    assert.equal(firstAttempt.ordinal, 101);
  }).pipe(Effect.provide(idAllocatorLayer)),
);
