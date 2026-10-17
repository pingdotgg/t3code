import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
  MAX_PROVIDER_FAILURE_CODE_LENGTH,
  MAX_PROVIDER_FAILURE_MESSAGE_LENGTH,
  ContextHandoffBudgetError,
} from "./failure.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

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

it("does not expose arbitrary cause messages and preserves explicit messages", () => {
  const cause = new Error("Adapter failed", {
    cause: new Error("Session expired. Sign in again."),
  });
  for (const value of [
    cause,
    Cause.fail(cause),
    "Session expired. Sign in again.",
    { message: "Session expired. Sign in again." },
  ]) {
    assert.equal(makeProviderFailure({ cause: value }).message, "Provider turn failed.");
    assert.equal(
      makeProviderFailure({ cause: value, message: "Provider connection closed." }).message,
      "Provider connection closed.",
    );
  }
});

it("preserves actionable handoff errors wrapped by turn startup", () => {
  const cause = new ProviderAdapter.ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread:handoff-error"),
    providerThreadId: ProviderThreadId.make("provider-thread:handoff-error"),
    runId: RunId.make("run:handoff-error"),
    cause: new ContextHandoffBudgetError(),
  });
  assert.equal(
    makeProviderFailure({ cause: Cause.fail(cause) }).message,
    new ContextHandoffBudgetError().message,
  );
});

const driver = ProviderDriverKind.make("claudeAgent");
const protocolError = (detail: string, reason?: ProviderAdapter.ProviderAdapterFailureReason) =>
  new ProviderAdapter.ProviderAdapterProtocolError({
    driver,
    detail,
    ...(reason === undefined ? {} : { reason }),
  });
const turnStart = (cause: unknown) =>
  new ProviderAdapter.ProviderAdapterTurnStartError({
    driver,
    threadId: ThreadId.make("thread:busy"),
    providerThreadId: ProviderThreadId.make("provider-thread:busy"),
    runId: RunId.make("run:busy"),
    cause,
  });
const GENERIC_TURN_START =
  "The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.";

it("names a typed reason beneath each wrapper category", () => {
  const categories = [
    ["ProviderAdapterTurnStartError", "The provider could not start this turn"],
    ["ProviderAdapterEventStreamError", "The provider event stream closed unexpectedly"],
    ["ProviderAdapterOpenSessionError", "The provider session could not be opened"],
    ["ProviderAdapterResumeThreadError", "The provider conversation could not be resumed"],
  ] as const;
  for (const [tag, summary] of categories) {
    const message = makeProviderFailure({
      // An Effect Cause between the category and its reason is transparent.
      cause: Cause.fail({
        _tag: tag,
        cause: Cause.fail(protocolError("Turn is still active.", "previous_turn_active")),
      }),
    }).message;
    assert.isTrue(message.startsWith(`${summary}: the previous turn is still running. `), message);
  }
  // A newer category replaces the reason that sat beneath an outer one.
  assert.isTrue(
    makeProviderFailure({
      cause: {
        _tag: "ProviderAdapterTurnStartError",
        cause: {
          _tag: "ProviderAdapterOpenSessionError",
          cause: protocolError("Failed to read attachment 'a'.", "attachment_unreadable"),
        },
      },
    }).message.startsWith(
      "The provider session could not be opened: an attachment could not be read. ",
    ),
  );
});

it("says why a turn could not start without showing the adapter's detail", () => {
  assert.equal(
    makeProviderFailure({
      cause: Cause.fail(
        turnStart(
          protocolError(
            "Claude provider turn provider-turn:previous is still active.",
            "previous_turn_active",
          ),
        ),
      ),
    }).message,
    "The provider could not start this turn: the previous turn is still running. Retry the turn; if it keeps failing, check the provider setup and server logs.",
  );
  assert.equal(
    makeProviderFailure({
      cause: turnStart(
        protocolError("Failed to read attachment 'attachment:private'.", "attachment_unreadable"),
      ),
    }).message,
    "The provider could not start this turn: an attachment could not be read. Retry the turn; if it keeps failing, check the provider setup and server logs.",
  );
});

it("keeps untyped adapter text out of the message", () => {
  for (const hidden of [
    // Adapter details can carry configuration, such as a malformed model name.
    protocolError("Pi model 'OPENAI_API_KEY=placeholder' must use provider/model format."),
    "This provider does not support context compaction.",
    new Error("socket hang up at 10.0.0.5"),
    // A reason the adapter boundary does not define, or an Object.prototype key.
    { _tag: "ProviderAdapterProtocolError", detail: "x", reason: "OPENAI_API_KEY=placeholder" },
    { _tag: "ProviderAdapterProtocolError", detail: "x", reason: "constructor" },
    // A provider-controlled tag naming an Object.prototype key is not a category.
    { _tag: "constructor", cause: "GOOGLE_API_KEY=AIzaPrivate" },
  ]) {
    const message = makeProviderFailure({ cause: turnStart(hidden) }).message;
    assert.equal(message, GENERIC_TURN_START);
  }
  // A typed reason with no category above it names nothing.
  assert.equal(
    makeProviderFailure({ cause: protocolError("busy", "previous_turn_active") }).message,
    "Provider turn failed.",
  );
});

it("does not expose defect text nested inside a known error category", () => {
  const failure = makeProviderFailure({
    cause: {
      _tag: "ProviderAdapterEventStreamError",
      cause: new Error(
        `Session rejected: Bearer nested-secret https://user:pass@example.test/path?token=secret ${"x".repeat(5000)}`,
      ),
    },
  });
  assert.include(failure.message, "provider event stream closed unexpectedly");
  assert.notInclude(failure.message, "Session rejected:");
  assert.notInclude(failure.message, "nested-secret");
  assert.notInclude(failure.message, "user:pass");
  assert.notInclude(failure.message, "token=secret");
  assert.isBelow(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
});

it("handles cyclic causes and throwing accessors", () => {
  const cyclic: { message: string; cause?: unknown } = {
    message: "Provider disconnected. Retry the turn.",
  };
  cyclic.cause = cyclic;
  assert.equal(makeProviderFailure({ cause: cyclic }).message, "Provider turn failed.");
  assert.equal(
    makeProviderFailure({
      cause: {
        get message() {
          throw new Error("unreadable");
        },
        get cause() {
          throw new Error("unreadable");
        },
      },
    }).message,
    "Provider turn failed.",
  );
});

it("falls back when inspecting a provider cause throws", () => {
  const cause = new Proxy(
    {},
    {
      has() {
        throw new Error("unreadable provider cause");
      },
    },
  );
  assert.equal(makeProviderFailure({ cause }).message, "Provider turn failed.");
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
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
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
  }).pipe(Effect.provide(IdAllocator.layer)),
);
