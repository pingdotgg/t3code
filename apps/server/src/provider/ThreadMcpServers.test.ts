import { assert, it } from "@effect/vitest";
import {
  OrchestrationV2ProviderThread,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  ThreadMcpLoginStarted,
  ThreadMcpServerStatus,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterMcpAuthError,
  ProviderAdapterMcpAuthVersionError,
  ProviderAdapterProtocolError,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMcpServers from "./ThreadMcpServers.ts";

const threadId = ThreadId.make("thread:mcp-servers");
const shell = liveThreadShell(threadId);
const providerThread = OrchestrationV2ProviderThread.make({
  id: ProviderThreadId.make("provider-thread:active"),
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex-active"),
  providerSessionId: ProviderSessionId.make("provider-session:active"),
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "native:active",
    strength: "strong",
  },
  nativeConversationHeadRef: null,
  status: "active",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: shell.createdAt,
  updatedAt: shell.updatedAt,
});
const projection = {
  ...idleThreadProjection(shell),
  thread: {
    ...idleThreadProjection(shell).thread,
    activeProviderThreadId: providerThread.id,
    providerInstanceId: ProviderInstanceId.make("claude-selected"),
    modelSelection: { instanceId: ProviderInstanceId.make("claude-selected"), model: "opus" },
  },
  providerThreads: [
    {
      ...providerThread,
      id: ProviderThreadId.make("provider-thread:inactive"),
      providerSessionId: ProviderSessionId.make("provider-session:inactive"),
    },
    providerThread,
  ],
};
const connected = ThreadMcpServerStatus.make({
  name: "example",
  status: "connected",
  authStatus: "oAuth",
  toolCount: 2,
});
const loginStarted = ThreadMcpLoginStarted.make({
  loginId: "opaque-login-id",
  authorizationUrl: "https://example.test/authorize",
});
const target = {
  threadId,
  providerInstanceId: providerThread.providerInstanceId,
  server: "example",
};

function runtime(mcpServers?: ProviderAdapter.ProviderAdapterV2McpServers) {
  return {
    instanceId: providerThread.providerInstanceId,
    driver: providerThread.driver,
    providerSessionId: ProviderSessionId.make("provider-session:active"),
    providerSession: {
      id: ProviderSessionId.make("provider-session:active"),
      driver: providerThread.driver,
      providerInstanceId: providerThread.providerInstanceId,
      status: "running",
      cwd: "/workspace",
      model: "gpt-5",
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: shell.createdAt,
      updatedAt: shell.updatedAt,
      lastError: null,
    },
    events: Stream.empty,
    ensureThread: () => Effect.die("unexpected ensureThread"),
    resumeThread: () => Effect.die("unexpected resumeThread"),
    startTurn: () => Effect.die("unexpected startTurn"),
    steerTurn: () => Effect.die("unexpected steerTurn"),
    interruptTurn: () => Effect.die("unexpected interruptTurn"),
    respondToRuntimeRequest: () => Effect.die("unexpected respondToRuntimeRequest"),
    readThreadSnapshot: () => Effect.die("unexpected readThreadSnapshot"),
    rollbackThread: () => Effect.die("unexpected rollbackThread"),
    forkThread: () => Effect.die("unexpected forkThread"),
    ...(mcpServers === undefined ? {} : { mcpServers }),
  } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
}

function testLayer(input: {
  records?: Effect.Effect<typeof projection>;
  session?: Effect.Effect<Option.Option<ProviderAdapter.ProviderAdapterV2SessionRuntime>>;
}) {
  return ThreadMcpServers.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadRecords: () => input.records ?? Effect.succeed(projection),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        get: (sessionId) => {
          assert.strictEqual(sessionId, providerThread.providerSessionId);
          return input.session ?? Effect.die("unexpected session lookup");
        },
      }),
    ),
  );
}

it.effect(
  "uses the active provider thread despite a different selected provider and returns its login binding",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<OrchestrationV2ProviderThread>>([]);
      const mcpServers: ProviderAdapter.ProviderAdapterV2McpServers = {
        status: (input) =>
          Ref.update(calls, (current) => [...current, input.providerThread]).pipe(
            Effect.as(connected),
          ),
        login: (input) =>
          Ref.update(calls, (current) => [...current, input.providerThread]).pipe(
            Effect.as(loginStarted),
          ),
        waitForLogin: () => Effect.die("unexpected waitForLogin"),
      };
      yield* Effect.gen(function* () {
        const servers = yield* ThreadMcpServers.ThreadMcpServers;
        assert.deepStrictEqual(yield* servers.status(target), connected);
        assert.deepStrictEqual(yield* servers.login(target), {
          ...loginStarted,
          providerThreadId: providerThread.id,
        });
        assert.deepStrictEqual(yield* Ref.get(calls), [providerThread, providerThread]);
      }).pipe(
        Effect.provide(testLayer({ session: Effect.succeed(Option.some(runtime(mcpServers))) })),
      );
    }),
);

it.effect.each(["unbound", "not-running"] as const)(
  "reports a stopped session when it is %s",
  (state) =>
    Effect.gen(function* () {
      const servers = yield* ThreadMcpServers.ThreadMcpServers;
      const error = yield* servers.login(target).pipe(Effect.flip);
      assert.instanceOf(error, ThreadMcpServers.ThreadMcpError);
      assert.strictEqual(error.reason, "session-stopped");
    }).pipe(
      Effect.provide(
        testLayer({
          records: Effect.succeed({
            ...projection,
            providerThreads: state === "unbound" ? [] : projection.providerThreads,
          }),
          session: Effect.succeed(Option.none()),
        }),
      ),
    ),
);

it.effect("reports unsupported native MCP management without starting a new runtime", () =>
  Effect.gen(function* () {
    const servers = yield* ThreadMcpServers.ThreadMcpServers;
    const error = yield* servers.status(target).pipe(Effect.flip);
    assert.instanceOf(error, ThreadMcpServers.ThreadMcpError);
    assert.strictEqual(error.reason, "provider-unsupported");
  }).pipe(Effect.provide(testLayer({ session: Effect.succeed(Option.some(runtime())) }))),
);

it.effect("preserves a safe update instruction for unsupported native OAuth versions", () =>
  Effect.gen(function* () {
    const servers = yield* ThreadMcpServers.ThreadMcpServers;
    const error = yield* servers.login(target).pipe(Effect.flip);
    assert.strictEqual(error.reason, "provider-version-unsupported");
    assert.include(error.message, "Update");
    assert.include(error.message, "restart the agent session");
  }).pipe(
    Effect.provide(
      testLayer({
        session: Effect.succeed(
          Option.some(
            runtime({
              status: () => Effect.die("unexpected native status"),
              login: () =>
                Effect.fail(
                  new ProviderAdapterMcpAuthVersionError({ driver: providerThread.driver }),
                ),
              waitForLogin: () => Effect.die("unexpected native wait"),
            }),
          ),
        ),
      }),
    ),
  ),
);

it.effect("keeps a failed status request distinct from completed sign-in", () => {
  const nativeError = new ProviderAdapterProtocolError({
    driver: providerThread.driver,
    detail: "private provider response with token=secret",
  });
  return Effect.gen(function* () {
    const servers = yield* ThreadMcpServers.ThreadMcpServers;
    const error = yield* servers.status(target).pipe(Effect.flip);
    assert.strictEqual(error.reason, "request-failed");
    assert.strictEqual(error.cause, nativeError);
    assert.notInclude(error.message, "Sign-in completion");
    assert.notInclude(error.message, "secret");
  }).pipe(
    Effect.provide(
      testLayer({
        session: Effect.succeed(
          Option.some(
            runtime({
              status: () => Effect.fail(nativeError),
              login: () => Effect.die("unexpected native login"),
              waitForLogin: () => Effect.die("unexpected native wait"),
            }),
          ),
        ),
      }),
    ),
  );
});

it.effect.each([
  { reason: "login-failed", instruction: "Start sign-in again" },
  { reason: "login-expired", instruction: "Start a new sign-in attempt" },
  { reason: "login-not-found", instruction: "start sign-in again" },
  { reason: "login-pending", instruction: "existing attempt" },
  { reason: "status-check-failed", instruction: "Check the server's status" },
] as const)("preserves a safe recovery instruction for $reason", ({ reason, instruction }) => {
  const nativeError = new ProviderAdapterMcpAuthError({
    driver: providerThread.driver,
    reason,
    cause: new Error("private provider response with token=secret"),
  });
  return Effect.gen(function* () {
    const servers = yield* ThreadMcpServers.ThreadMcpServers;
    const error =
      reason === "login-pending"
        ? yield* servers.login(target).pipe(Effect.flip)
        : yield* servers
            .waitForLogin({
              ...target,
              loginId: loginStarted.loginId,
              providerThreadId: providerThread.id,
            })
            .pipe(Effect.flip);
    assert.strictEqual(error.reason, reason);
    assert.strictEqual(error.cause, nativeError);
    assert.include(error.message, instruction);
    assert.notInclude(error.message, "secret");
    if (reason === "status-check-failed") {
      assert.include(error.message, "OAuth sign-in completed");
    } else {
      assert.notInclude(error.message, "completed");
    }
  }).pipe(
    Effect.provide(
      testLayer({
        session: Effect.succeed(
          Option.some(
            runtime({
              status: () => Effect.die("unexpected native status"),
              login: () => Effect.fail(nativeError),
              waitForLogin: () => Effect.fail(nativeError),
            }),
          ),
        ),
      }),
    ),
  );
});

it.effect("rejects an old provider thread before touching its native OAuth attempt", () =>
  Effect.gen(function* () {
    const servers = yield* ThreadMcpServers.ThreadMcpServers;
    const error = yield* servers
      .waitForLogin({
        ...target,
        loginId: loginStarted.loginId,
        providerThreadId: ProviderThreadId.make("provider-thread:old"),
      })
      .pipe(Effect.flip);
    assert.instanceOf(error, ThreadMcpServers.ThreadMcpError);
    assert.strictEqual(error.reason, "session-changed");
  }).pipe(
    Effect.provide(
      testLayer({
        session: Effect.succeed(
          Option.some(
            runtime({
              status: () => Effect.die("unexpected native status"),
              login: () => Effect.die("unexpected native login"),
              waitForLogin: () => Effect.die("must not wait for the old provider thread"),
            }),
          ),
        ),
      }),
    ),
  ),
);

it.effect.each(["provider-thread", "runtime", "native-thread"] as const)(
  "rejects connectivity from an OAuth wait after the %s changes",
  (changed) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const records = yield* Ref.make(projection);
      const native: ProviderAdapter.ProviderAdapterV2McpServers = {
        status: () => Effect.succeed(connected),
        login: () => Effect.succeed(loginStarted),
        waitForLogin: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(connected),
          ),
      };
      const session = yield* Ref.make<ProviderAdapter.ProviderAdapterV2SessionRuntime>(
        runtime(native),
      );
      yield* Effect.gen(function* () {
        const servers = yield* ThreadMcpServers.ThreadMcpServers;
        const waiting = yield* servers
          .waitForLogin({
            ...target,
            loginId: loginStarted.loginId,
            providerThreadId: providerThread.id,
          })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(entered);
        if (changed === "provider-thread") {
          const replacementId = ProviderThreadId.make("provider-thread:replacement");
          yield* Ref.update(records, (current) => ({
            ...current,
            thread: { ...current.thread, activeProviderThreadId: replacementId },
            providerThreads: [{ ...providerThread, id: replacementId }],
          }));
        } else if (changed === "native-thread") {
          yield* Ref.update(records, (current) => ({
            ...current,
            providerThreads: current.providerThreads.map((candidate) =>
              candidate.id === providerThread.id
                ? OrchestrationV2ProviderThread.make({
                    ...candidate,
                    nativeThreadRef: {
                      driver: providerThread.driver,
                      nativeId: "native:replacement",
                      strength: "strong",
                    },
                  })
                : candidate,
            ),
          }));
        } else {
          yield* Ref.set(session, runtime(native));
        }
        yield* Deferred.succeed(release, undefined);
        const error = yield* Fiber.join(waiting);
        assert.instanceOf(error, ThreadMcpServers.ThreadMcpError);
        assert.strictEqual(error.reason, "session-changed");
      }).pipe(
        Effect.provide(
          testLayer({
            records: Ref.get(records),
            session: Ref.get(session).pipe(Effect.map(Option.some)),
          }),
        ),
      );
    }),
);

it.effect("keeps a failed server status after native OAuth saves its credentials", () =>
  Effect.gen(function* () {
    const failed = ThreadMcpServerStatus.make({ ...connected, status: "failed", toolCount: 0 });
    yield* Effect.gen(function* () {
      const servers = yield* ThreadMcpServers.ThreadMcpServers;
      assert.deepStrictEqual(
        yield* servers.waitForLogin({
          ...target,
          loginId: loginStarted.loginId,
          providerThreadId: providerThread.id,
        }),
        failed,
      );
    }).pipe(
      Effect.provide(
        testLayer({
          session: Effect.succeed(
            Option.some(
              runtime({
                status: () => Effect.succeed(failed),
                login: () => Effect.succeed(loginStarted),
                waitForLogin: () => Effect.succeed(failed),
              }),
            ),
          ),
        }),
      ),
    );
  }),
);

it.effect("refuses an old caller instance before touching the current provider", () =>
  Effect.gen(function* () {
    const servers = yield* ThreadMcpServers.ThreadMcpServers;
    const error = yield* servers
      .login({
        ...target,
        providerInstanceId: ProviderInstanceId.make("codex-previous"),
      })
      .pipe(Effect.flip);
    assert.instanceOf(error, ThreadMcpServers.ThreadMcpError);
    assert.strictEqual(error.reason, "session-changed");
  }).pipe(Effect.provide(testLayer({}))),
);
