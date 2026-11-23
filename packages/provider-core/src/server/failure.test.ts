import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  knownProviderFailureMessage,
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

it("reports an oversized provider request as not retryable instead of the gateway's error page", () => {
  for (const message of [
    "413 <html>\n<head><title>413 Request Entity Too Large</title></head>\n<body>\n<center><h1>413 Request Entity Too Large</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>",
    "unexpected status 413 Payload Too Large: request body exceeds the limit",
    'API Error: 413 {"type":"error","error":{"type":"request_too_large"}}',
  ]) {
    const failure = makeProviderFailure({ message, class: "provider_error", retryable: true });

    assert.equal(failure.class, "provider_error");
    assert.equal(failure.retryable, false);
    assert.equal(
      failure.message,
      "This thread's request is too large for the provider (HTTP 413), so retrying fails the same way. Start a fresh session with /clear, or continue in a new thread.",
    );
  }
  for (const message of [
    "Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 41300.",
    "Rate limited after 413 requests.",
    "Tool result content too large to return.",
  ]) {
    const failure = makeProviderFailure({ message, retryable: true });
    assert.equal(failure.message, message);
    assert.equal(failure.retryable, true);
  }
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

it("preserves actionable T3 errors wrapped by turn startup", () => {
  for (const error of [
    new ContextHandoffBudgetError(),
    new ContextHandoffBackgroundWorkError(),
    new ProviderSetupError({
      instanceId: ProviderInstanceId.make("codex"),
      operation: "runtime",
      detail: "Codex 0.144.3 does not work with this T3 Code release.",
    }),
  ]) {
    const cause = new ProviderAdapter.ProviderAdapterTurnStartError({
      driver: ProviderDriverKind.make("codex"),
      threadId: ThreadId.make("thread:handoff-error"),
      providerThreadId: ProviderThreadId.make("provider-thread:handoff-error"),
      runId: RunId.make("run:handoff-error"),
      cause: error,
    });
    assert.equal(makeProviderFailure({ cause: Cause.fail(cause) }).message, error.message);
  }
  const unanswered = {
    _tag: "CodexAppServerUnresponsiveError",
    message: "Codex app-server did not answer turn/start within 2 minutes.",
  };
  assert.equal(
    makeProviderFailure({
      cause: Cause.fail({ _tag: "ProviderAdapterEventStreamError", cause: unanswered }),
    }).message,
    unanswered.message,
  );
});

it("names how the provider process exited and the stage it failed in, without its output", () => {
  for (const [exit, status] of [
    [{ signal: "SIGILL" }, " after signal SIGILL"],
    [{ code: 134 }, " with code 134"],
    [{}, ""],
    [{ signal: "SIGILL Bearer signal-secret" }, ""],
  ] as const) {
    const sessionOpenFailure = {
      _tag: "ProviderSessionOpenError",
      cause: new ProviderAdapter.ProviderAdapterOpenSessionError({
        driver: ProviderDriverKind.make("antigravity"),
        providerSessionId: ProviderSessionId.make("provider-session:private-id"),
        cause: {
          _tag: "AcpProcessExitedError",
          ...exit,
          pid: 4242,
          stderr: "*** SIGILL *** token=stderr-secret",
          cause: new Error("Process interrupted with private-detail"),
        },
      }),
    };
    const expected = `The provider session could not be opened: the provider process exited${status}. Check the server logs for the provider's output, then retry the turn.`;
    assert.equal(knownProviderFailureMessage(sessionOpenFailure), expected);
    assert.equal(makeProviderFailure({ cause: Cause.fail(sessionOpenFailure) }).message, expected);
  }
  assert.equal(
    makeProviderFailure({ cause: { _tag: "AcpProcessExitedError", code: 1 } }).message,
    "The provider process exited with code 1. Check the server logs for the provider's output, then retry the turn.",
  );
  const denied = makeProviderFailure({
    cause: {
      _tag: "CodexAppServerProcessExitedError",
      code: 1,
      stderr: "Error: Operation not permitted (os error 1) at /Users/private/Desktop",
    },
  }).message;
  assert.include(denied, "The provider process exited with code 1. It was denied access");
  assert.include(denied, "Files and Folders");
  assert.notInclude(denied, "/Users/private");
});

it("tells the user to sign in only when an ACP agent answers auth_required", () => {
  const providerSessionId = ProviderSessionId.make("provider-session:private-id");
  const sessionOpenFailure = (code: number) => ({
    _tag: "ProviderSessionOpenError",
    cause: new ProviderAdapter.ProviderAdapterOpenSessionError({
      driver: ProviderDriverKind.make("acpRegistry"),
      providerSessionId,
      cause: Cause.fail({ _tag: "AcpRequestError", code, errorMessage: "Private agent text" }),
    }),
  });

  assert.equal(
    makeProviderFailure({ cause: Cause.fail(sessionOpenFailure(-32000)) }).message,
    "The provider needs you to sign in. Sign in from its provider settings or with its own CLI or app, then retry the turn.",
  );
  assert.isUndefined(knownProviderFailureMessage(sessionOpenFailure(-32603)));
});

it("keeps unrecognized reasons and provider text out of category messages", () => {
  for (const cause of [
    "Private launch command",
    { _tag: "ProviderAdapterProtocolError", detail: "Pi model 'private-config' is invalid" },
    { _tag: "ProviderAdapterProtocolError", reason: "private-config" },
    { _tag: "ProviderAdapterProtocolError", reason: "constructor" },
    { _tag: "constructor", cause: "private-config" },
    {
      _tag: "CodexAppServerRequestError",
      method: "thread/goal/set",
      message: "thread not found: private-thread",
    },
    {
      _tag: "CodexAppServerRequestError",
      method: "turn/start",
      message: "goal objective must be at most 4000 characters",
    },
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

it("names a managed Codex policy that refuses the thread's access mode", () => {
  const message = makeProviderFailure({
    cause: {
      _tag: "ProviderAdapterTurnStartError",
      cause: {
        _tag: "CodexAppServerRequestError",
        method: "turn/start",
        code: -32600,
        message:
          "invalid thread settings override: invalid value for `sandbox_mode`: `DangerFullAccess` is not in the allowed set [ReadOnly, WorkspaceWrite] (set by /etc/codex/requirements.toml)",
      },
    },
  }).message;
  assert.notInclude(message, "Retry the turn");
  assert.match(message, /requirements|policy/iu);
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

it("explains a native thread another client is writing to", () => {
  const inUse = new ProviderAdapter.ProviderAdapterThreadInUseError({
    driver: ProviderDriverKind.make("codex"),
    providerThreadId: ProviderThreadId.make("provider-thread:in-use"),
    detail: "This conversation is open in another Codex client.",
    cause: new Error("thread provider-thread:in-use already has an active writer"),
  });
  const cause = new ProviderAdapter.ProviderAdapterTurnStartError({
    driver: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("thread:in-use"),
    providerThreadId: ProviderThreadId.make("provider-thread:in-use"),
    runId: RunId.make("run:in-use"),
    cause: inUse,
  });
  assert.equal(makeProviderFailure({ cause: Cause.fail(cause) }).message, inUse.message);
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
