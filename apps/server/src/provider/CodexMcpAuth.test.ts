import { assert, describe, it } from "@effect/vitest";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import * as CodexMcpAuth from "./CodexMcpAuth.ts";

const serverInput = { threadId: "native-thread", server: "example" };
const loginRequest = (id: number): CodexReplay.CodexAppServerReplayEntry => ({
  type: "expect_outbound",
  frame: {
    id,
    method: "mcpServer/oauth/login",
    params: { name: "example", threadId: "native-thread", timeoutSecs: 300 },
  },
});
const loginResponse = (
  id: number,
  loginId: string | null,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: "login-response",
  frame: {
    id,
    result: { authorizationUrl: "https://example.com/authorize?state=private", loginId },
  },
});
const completion = (
  loginId: string,
  success: boolean,
  overrides: { readonly name?: string; readonly threadId?: string } = {},
) =>
  ({
    type: "emit_inbound",
    frame: {
      method: "mcpServer/oauthLogin/completed",
      params: { name: "example", threadId: "native-thread", loginId, success, ...overrides },
    },
  }) satisfies CodexReplay.CodexAppServerReplayEntry;
const statusExchange = (
  id: number,
  runtimeStatus: "connected" | "failed" | null,
): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => [
  {
    type: "expect_outbound",
    frame: {
      id,
      method: "mcpServerStatus/list",
      params: { threadId: "native-thread", serverName: "example", detail: "toolsAndAuthOnly" },
    },
  },
  {
    type: "emit_inbound",
    frame: {
      id,
      result: {
        data: [
          {
            name: "example",
            runtimeStatus,
            authStatus: "oAuth",
            tools: {},
            resources: [],
            resourceTemplates: [],
          },
        ],
        nextCursor: null,
      },
    },
  },
];
const transcript = (
  entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
): CodexReplay.CodexAppServerReplayTranscript => ({
  provider: "codex",
  protocol: "codex.app-server",
  version: "0.162.1",
  scenario: "mcp-auth",
  entries,
});

describe("Codex MCP OAuth", () => {
  it.effect("waits for native completion after the authorization URL is returned", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const browserFinished = yield* Deferred.make<void>();
      const completed = completion("owned", true);
      const driver = yield* CodexReplay.makeReplayDriver(
        transcript([
          loginRequest(1),
          loginResponse(1, "owned"),
          { ...completed, label: "browser-completion" },
          ...statusExchange(2, "connected"),
        ]),
        {
          beforeEmitInbound: (entry) =>
            entry.label === "browser-completion"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(browserFinished)),
                )
              : Effect.void,
        },
      );
      yield* Effect.gen(function* () {
        const auth = yield* CodexMcpAuth.make;
        const started = yield* auth.login(serverInput);
        yield* Deferred.await(entered);
        const waiting = yield* auth
          .waitForLogin({ ...serverInput, loginId: started.loginId })
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.isTrue(yield* auth.hasPendingLogin());
        yield* Deferred.succeed(browserFinished, undefined);
        assert.equal((yield* Fiber.join(waiting)).status, "connected");
        assert.isFalse(yield* auth.hasPendingLogin());
      }).pipe(Effect.provide(CodexReplay.layerReplayWithDriver(driver)));
    }),
  );

  it.effect("correlates early completion and verifies the same thread's native connection", () =>
    Effect.gen(function* () {
      const auth = yield* CodexMcpAuth.make;
      const started = yield* auth.login(serverInput);
      assert.deepEqual(started, {
        loginId: "owned",
        authorizationUrl: "https://example.com/authorize?state=private",
      });
      assert.isTrue(yield* auth.hasPendingLogin("native-thread"));
      assert.isFalse(yield* auth.hasPendingLogin("other-thread"));
      assert.deepEqual(yield* auth.waitForLogin({ ...serverInput, loginId: started.loginId }), {
        name: "example",
        status: "connected",
        authStatus: "oAuth",
        toolCount: 0,
      });
      assert.isFalse(yield* auth.hasPendingLogin());
    }).pipe(
      Effect.provide(
        CodexReplay.layerReplay(
          transcript([
            loginRequest(1),
            completion("owned", false, { threadId: "other-thread" }),
            completion("owned", false, { name: "other-server" }),
            completion("unrelated-login", false),
            completion("owned", true),
            loginResponse(1, "owned"),
            ...statusExchange(2, "connected"),
          ]),
        ),
      ),
    ),
  );

  it.effect("failed OAuth never probes or claims a usable connection", () =>
    Effect.gen(function* () {
      const auth = yield* CodexMcpAuth.make;
      yield* auth.login(serverInput);
      const failure = yield* auth
        .waitForLogin({ ...serverInput, loginId: "owned" })
        .pipe(Effect.flip);
      assert.containsSubset(failure, {
        _tag: "ProviderAdapterMcpAuthError",
        reason: "login-failed",
      });
      assert.isFalse(yield* auth.hasPendingLogin());
    }).pipe(
      Effect.provide(
        CodexReplay.layerReplay(
          transcript([loginRequest(1), completion("owned", false), loginResponse(1, "owned")]),
        ),
      ),
    ),
  );

  it.effect("reports status failure after completed OAuth without requesting another login", () =>
    Effect.gen(function* () {
      const auth = yield* CodexMcpAuth.make;
      yield* auth.login(serverInput);
      const failure = yield* auth
        .waitForLogin({ ...serverInput, loginId: "owned" })
        .pipe(Effect.flip);
      assert.containsSubset(failure, {
        _tag: "ProviderAdapterMcpAuthError",
        reason: "status-check-failed",
        cause: { _tag: "ProviderAdapterProtocolError" },
      });
      assert.notInclude(failure.message, "unsafe-provider-error");
      assert.isFalse(yield* auth.hasPendingLogin());
      const standaloneFailure = yield* auth.status(serverInput).pipe(Effect.flip);
      assert.equal(standaloneFailure._tag, "ProviderAdapterProtocolError");
    }).pipe(
      Effect.provide(
        CodexReplay.layerReplay(
          transcript([
            loginRequest(1),
            completion("owned", true),
            loginResponse(1, "owned"),
            ...statusExchange(2, "connected").slice(0, 1),
            {
              type: "emit_inbound",
              frame: { id: 2, error: { code: -32000, message: "unsafe-provider-error" } },
            },
            ...statusExchange(3, "connected").slice(0, 1),
            {
              type: "emit_inbound",
              frame: { id: 3, error: { code: -32000, message: "unsafe-provider-error" } },
            },
          ]),
        ),
      ),
    ),
  );

  it.effect("successful OAuth preserves a failed native connection status", () =>
    Effect.gen(function* () {
      const auth = yield* CodexMcpAuth.make;
      yield* auth.login(serverInput);
      const server = yield* auth.waitForLogin({ ...serverInput, loginId: "owned" });
      assert.equal(server.status, "failed");
      assert.equal(server.authStatus, "oAuth");
    }).pipe(
      Effect.provide(
        CodexReplay.layerReplay(
          transcript([
            loginRequest(1),
            completion("owned", true),
            loginResponse(1, "owned"),
            ...statusExchange(2, "failed"),
          ]),
        ),
      ),
    ),
  );

  it.effect("requires native login ids and expires unsupported attempts", () =>
    Effect.gen(function* () {
      const auth = yield* CodexMcpAuth.make;
      const failure = yield* auth.login(serverInput).pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterMcpAuthVersionError");
      assert.equal(
        failure.detail,
        "Update the provider to a version that supports correlated MCP OAuth login.",
      );
      assert.isTrue(yield* auth.hasPendingLogin());
      yield* TestClock.adjust("301 seconds");
      assert.isFalse(yield* auth.hasPendingLogin());
    }).pipe(
      Effect.provide(
        CodexReplay.layerReplay(transcript([loginRequest(1), loginResponse(1, null)])),
      ),
    ),
  );

  it.effect(
    "rejects overlapping and foreign ownership, expires abandoned attempts, and ignores stale completion",
    () =>
      Effect.gen(function* () {
        const auth = yield* CodexMcpAuth.make;
        yield* auth.login(serverInput);
        const overlapping = yield* auth.login(serverInput).pipe(Effect.flip);
        assert.containsSubset(overlapping, {
          _tag: "ProviderAdapterMcpAuthError",
          reason: "login-pending",
        });
        const wrongThread = yield* auth
          .waitForLogin({ ...serverInput, threadId: "other-thread", loginId: "old" })
          .pipe(Effect.flip);
        const wrongServer = yield* auth
          .waitForLogin({ ...serverInput, server: "other-server", loginId: "old" })
          .pipe(Effect.flip);
        const wrongLogin = yield* auth
          .waitForLogin({ ...serverInput, loginId: "foreign" })
          .pipe(Effect.flip);
        assert.containsSubset(wrongThread, {
          _tag: "ProviderAdapterMcpAuthError",
          reason: "login-not-found",
        });
        assert.containsSubset(wrongServer, {
          _tag: "ProviderAdapterMcpAuthError",
          reason: "login-not-found",
        });
        assert.containsSubset(wrongLogin, {
          _tag: "ProviderAdapterMcpAuthError",
          reason: "login-not-found",
        });
        assert.isTrue(yield* auth.hasPendingLogin());
        yield* TestClock.adjust("301 seconds");
        assert.isFalse(yield* auth.hasPendingLogin());
        const expired = yield* auth
          .waitForLogin({ ...serverInput, loginId: "old" })
          .pipe(Effect.flip);
        assert.containsSubset(expired, {
          _tag: "ProviderAdapterMcpAuthError",
          reason: "login-not-found",
        });
        yield* auth.login(serverInput);
        const result = yield* auth
          .waitForLogin({ ...serverInput, loginId: "new" })
          .pipe(Effect.flip);
        assert.equal(result.reason, "login-failed");
        assert.isFalse(yield* auth.hasPendingLogin());
      }).pipe(
        Effect.provide(
          CodexReplay.layerReplay(
            transcript([
              loginRequest(1),
              loginResponse(1, "old"),
              loginRequest(2),
              completion("old", true),
              completion("new", false),
              loginResponse(2, "new"),
            ]),
          ),
        ),
      ),
  );

  it.effect("reserves an interrupted native login until its deadline", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const driver = yield* CodexReplay.makeReplayDriver(
        transcript([loginRequest(1), loginResponse(1, "owned")]),
        {
          beforeEmitInbound: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        },
      );
      yield* Effect.gen(function* () {
        const auth = yield* CodexMcpAuth.make;
        const starting = yield* auth
          .login(serverInput)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        assert.isTrue(yield* auth.hasPendingLogin());
        yield* Fiber.interrupt(starting);
        assert.isTrue(yield* auth.hasPendingLogin());
        yield* Deferred.succeed(release, undefined);
        yield* TestClock.adjust("301 seconds");
        assert.isFalse(yield* auth.hasPendingLogin());
      }).pipe(Effect.provide(CodexReplay.layerReplayWithDriver(driver)));
    }),
  );

  it.effect("an interrupted waiter can resume the same owned login", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const statusEntries = statusExchange(2, "connected").map((entry) =>
        entry.type === "emit_inbound" ? { ...entry, label: "blocked-status" } : entry,
      );
      const driver = yield* CodexReplay.makeReplayDriver(
        transcript([
          loginRequest(1),
          completion("owned", true),
          loginResponse(1, "owned"),
          ...statusEntries,
          ...statusExchange(3, "connected"),
        ]),
        {
          beforeEmitInbound: (entry) =>
            entry.label === "blocked-status"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
        },
      );
      yield* Effect.gen(function* () {
        const auth = yield* CodexMcpAuth.make;
        yield* auth.login(serverInput);
        const waiter = yield* auth
          .waitForLogin({ ...serverInput, loginId: "owned" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(waiter);
        assert.isTrue(yield* auth.hasPendingLogin());
        const overlapping = yield* auth.login(serverInput).pipe(Effect.flip);
        assert.containsSubset(overlapping, {
          _tag: "ProviderAdapterMcpAuthError",
          reason: "login-pending",
        });
        yield* Deferred.succeed(release, undefined);
        const server = yield* auth.waitForLogin({ ...serverInput, loginId: "owned" });
        assert.equal(server.status, "connected");
        assert.isFalse(yield* auth.hasPendingLogin());
      }).pipe(Effect.provide(CodexReplay.layerReplayWithDriver(driver)));
    }),
  );

  it.effect("a waiting login times out and releases its runtime pin", () =>
    Effect.gen(function* () {
      const auth = yield* CodexMcpAuth.make;
      yield* auth.login(serverInput);
      const waiter = yield* auth
        .waitForLogin({ ...serverInput, loginId: "owned" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("300 seconds");
      const failure = yield* Fiber.join(waiter).pipe(Effect.flip);
      assert.equal(failure.reason, "login-expired");
      assert.isFalse(yield* auth.hasPendingLogin());
    }).pipe(
      Effect.provide(
        CodexReplay.layerReplay(transcript([loginRequest(1), loginResponse(1, "owned")])),
      ),
    ),
  );

  it.effect("reports expiration when a known login is first awaited at its deadline", () =>
    Effect.gen(function* () {
      const auth = yield* CodexMcpAuth.make;
      yield* auth.login(serverInput);
      yield* TestClock.adjust("300 seconds");
      const expired = yield* auth
        .waitForLogin({ ...serverInput, loginId: "owned" })
        .pipe(Effect.flip);
      assert.equal(expired.reason, "login-expired");
      assert.isFalse(yield* auth.hasPendingLogin());
      const pruned = yield* auth
        .waitForLogin({ ...serverInput, loginId: "owned" })
        .pipe(Effect.flip);
      assert.equal(pruned.reason, "login-not-found");
    }).pipe(
      Effect.provide(
        CodexReplay.layerReplay(
          transcript([loginRequest(1), completion("owned", true), loginResponse(1, "owned")]),
        ),
      ),
    ),
  );
});
