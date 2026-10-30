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
  MAX_PROVIDER_FAILURE_MESSAGE_LENGTH,
  ContextHandoffBudgetError,
  ContextHandoffBackgroundWorkError,
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

it("keeps structured ACP exit details through cause wrappers without reading arbitrary messages", () => {
  const cause = {
    _tag: "AcpProcessExitedError",
    code: 23,
    stderr: "Synthetic configuration failed.\napi_key=fixture-only-key",
    message: "Untrusted alternative message",
  };
  for (const value of [
    cause,
    Cause.fail(cause),
    { _tag: "ProviderAdapterTurnStartError", cause },
  ]) {
    const failure = makeProviderFailure({ cause: value, class: "provider_error" });
    assert.equal(failure.code, "23");
    assert.equal(
      failure.message,
      "ACP process exited with code 23\nSynthetic configuration failed.\n[REDACTED credential diagnostic]",
    );
  }
  assert.equal(
    makeProviderFailure({ cause, message: "Explicit failure", code: "explicit" }).message,
    "Explicit failure",
  );
  assert.equal(makeProviderFailure({ cause, code: "explicit" }).code, "explicit");
  assert.equal(
    makeProviderFailure({ cause: { _tag: "AcpProcessExitedError", signal: "SIGTERM" } }).message,
    "ACP process exited after signal SIGTERM",
  );
  assert.equal(
    makeProviderFailure({ cause: { _tag: "AcpProcessExitedError", signal: "SIGTERM" } }).code,
    "SIGTERM",
  );
  assert.equal(
    makeProviderFailure({
      cause: { _tag: "AcpProcessExitedError", code: NaN, signal: "unsafe signal" },
    }).message,
    "ACP process exited",
  );
});

it("redacts prefixed credential fields and escaped quoted values in ACP stderr", () => {
  const stderr = [
    "Synthetic configuration failed.",
    "MISTRAL_API_KEY=FixtureOnly0123456789abcdefABCDEF",
    "GEMINI_API_KEY=AIzaFixtureOnly0123456789",
    JSON.stringify({
      refresh_token: "fixture-refresh-value",
      client_secret: "fixture-client-secret",
      private_key: "-----BEGIN PRIVATE KEY-----\nFIXTURE",
      token: 'fixture"secret-tail',
    }),
  ].join("\n");
  const failure = makeProviderFailure({
    cause: { _tag: "AcpProcessExitedError", code: 23, stderr },
  });
  assert.include(failure.message, "Synthetic configuration failed.");
  for (const value of [
    "FixtureOnly",
    "AIzaFixture",
    "fixture-refresh",
    "fixture-client",
    "FIXTURE",
    "secret-tail",
  ]) {
    assert.notInclude(failure.message, value);
  }
});

it("withholds whole ACP stderr lines containing credential markers", () => {
  for (const line of [
    "AWS_SECRET_ACCESS_KEY=FixtureOnlyValue0123",
    "SECRET_KEY=FixtureOnlyValue0123",
    "STRIPE_SECRET_KEY=FixtureOnlyValue0123",
    JSON.stringify({ clientSecret: "fixture-client-value", refreshToken: "fixture-refresh-value" }),
    "secretAccessKey: FixtureOnlyValue",
    "Authorization: token FixtureOnlyValue",
    "Diagnostic only mentions a password; no value is present.",
    "CLIENTSECRET=FixtureOnlyValue",
    "GOOGLE_KEY=FixtureOnlyValue",
    "Unknown configuration key; no credential is present.",
  ]) {
    const failure = makeProviderFailure({
      cause: {
        _tag: "AcpProcessExitedError",
        code: 23,
        stderr: `Synthetic configuration failed.\n${line}\nFinal diagnostic.`,
      },
    });
    assert.equal(
      failure.message,
      "ACP process exited with code 23\nSynthetic configuration failed.\n[REDACTED credential diagnostic]\nFinal diagnostic.",
    );
  }
});

it("withholds multiline private-key bodies, including unterminated keys", () => {
  for (const end of ["-----END PRIVATE KEY-----", ""]) {
    const failure = makeProviderFailure({
      cause: {
        _tag: "AcpProcessExitedError",
        code: 23,
        stderr: `Synthetic configuration failed.\n-----BEGIN PRIVATE KEY-----\nZml4dHVyZS1wcml2YXRlLWJvZHk=\n${end}`,
      },
    });
    assert.include(failure.message, "ACP process exited with code 23");
    assert.notInclude(failure.message, "Zml4dHVyZS1wcml2YXRlLWJvZHk=");
  }
});

it("redacts standalone service tokens in ACP exit diagnostics", () => {
  const failure = makeProviderFailure({
    cause: {
      _tag: "AcpProcessExitedError",
      code: 23,
      stderr:
        "Synthetic failure: ghp_fixture0123456789 xoxb-fixture-0123456789 github_pat_fixture_123 gho_fixture123 ghu_fixture123 ghs_fixture123 ghr_fixture123",
    },
  });
  assert.equal(
    failure.message,
    "ACP process exited with code 23\nSynthetic failure: [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]",
  );
});

it("redacts before bounding the tail of ACP exit diagnostics", () => {
  const failure = makeProviderFailure({
    cause: {
      _tag: "AcpProcessExitedError",
      code: 23,
      stderr: `api_key=${"fixturecredential".repeat(600)}\n${"old diagnostic\n".repeat(600)}Final synthetic diagnostic.`,
    },
  });
  assert.isAtMost(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  assert.isTrue(failure.message.startsWith("ACP process exited with code 23\n…"));
  assert.isTrue(failure.message.endsWith("Final synthetic diagnostic."));
  assert.notInclude(failure.message, "fixturecredential");
});

it("does not split a surrogate pair at the start of an ACP stderr tail", () => {
  for (const suffix of ["Final.", "Final.!"]) {
    const failure = makeProviderFailure({
      cause: { _tag: "AcpProcessExitedError", code: 23, stderr: `${"🚀".repeat(3_000)}${suffix}` },
    });
    assert.isAtMost(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
    assert.notMatch(failure.message, /[\uD800-\uDFFF]/u);
    assert.isTrue(failure.message.endsWith(suffix));
  }
});

it("redacts credentials whose key names end in a credential word", () => {
  const failure = makeProviderFailure({
    code: '{"refresh_token":"code value"}',
    message:
      'oauth refresh failed: client_secret=client-value refresh_token=refresh-value {"client_secret":"json-value"} clientSecret: camel-value X-Auth-Token: header-value max_tokens=4096',
  });

  assert.equal(failure.code, '{"refresh_token":"[REDACTED]"}');
  assert.equal(
    failure.message,
    'oauth refresh failed: client_secret=[REDACTED] refresh_token=[REDACTED] {"client_secret":"[REDACTED]"} clientSecret: [REDACTED] X-Auth-Token: [REDACTED] max_tokens=4096',
  );
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
  for (const error of [new ContextHandoffBudgetError(), new ContextHandoffBackgroundWorkError()]) {
    const cause = new ProviderAdapter.ProviderAdapterTurnStartError({
      driver: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("thread:handoff-error"),
      providerThreadId: ProviderThreadId.make("provider-thread:handoff-error"),
      runId: RunId.make("run:handoff-error"),
      cause: error,
    });
    assert.equal(makeProviderFailure({ cause: Cause.fail(cause) }).message, error.message);
  }
});

it("keeps unrecognized reasons and provider text out of category messages", () => {
  for (const cause of [
    "Private launch command",
    { _tag: "ProviderAdapterProtocolError", detail: "Pi model 'private-config' is invalid" },
    { _tag: "ProviderAdapterProtocolError", reason: "private-config" },
    { _tag: "ProviderAdapterProtocolError", reason: "constructor" },
    { _tag: "constructor", cause: "private-config" },
  ]) {
    assert.equal(
      makeProviderFailure({ cause: { _tag: "ProviderAdapterTurnStartError", cause } }).message,
      "The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.",
    );
  }
  assert.equal(
    makeProviderFailure({
      cause: { _tag: "ProviderAdapterProtocolError", reason: "previous_turn_active" },
    }).message,
    "Provider turn failed.",
  );
});

it("uses the innermost category without carrying an outer reason into it", () => {
  assert.equal(
    makeProviderFailure({
      cause: {
        _tag: "ProviderAdapterTurnStartError",
        cause: {
          _tag: "ProviderAdapterProtocolError",
          reason: "previous_turn_active",
          cause: Cause.fail({ _tag: "ProviderAdapterOpenSessionError" }),
        },
      },
    }).message,
    "The provider session could not be opened. Check that the provider is installed and signed in, then retry the turn.",
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
