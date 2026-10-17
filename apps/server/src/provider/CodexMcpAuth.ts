import { ProviderDriverKind, type ThreadMcpServerStatus } from "@t3tools/contracts";
import {
  ProviderAdapterMcpAuthError,
  ProviderAdapterMcpAuthVersionError,
  ProviderAdapterProtocolError,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexError from "effect-codex-app-server/errors";

const LOGIN_TIMEOUT_SECS = 300;
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
const connectionStatuses = {
  notStarted: "pending",
  starting: "pending",
  connected: "connected",
  authenticationRequired: "needsAuth",
  failed: "failed",
  cancelled: "failed",
  disabled: "disabled",
} as const;

interface ServerInput {
  readonly threadId: string;
  readonly server: string;
}

interface PendingLogin extends ServerInput {
  readonly loginId: string | null;
  readonly expiresAt: number;
  readonly completion: Deferred.Deferred<boolean, ProviderAdapterMcpAuthError>;
  readonly earlyCompletions: ReadonlyMap<string, boolean>;
}

const loginKey = (input: ServerInput) => JSON.stringify([input.threadId, input.server]);

export const make = Effect.gen(function* () {
  const client = yield* CodexClient.CodexAppServerClient;
  const pending = new Map<string, PendingLogin>();
  const expire = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const entry of pending) {
      if (entry[1].expiresAt > now) continue;
      pending.delete(entry[0]);
      yield* Deferred.fail(
        entry[1].completion,
        new ProviderAdapterMcpAuthError({
          driver: CODEX_DRIVER_KIND,
          reason: "login-expired",
        }),
      );
    }
  });

  yield* client.handleServerNotification("mcpServer/oauthLogin/completed", (notification) =>
    Effect.gen(function* () {
      yield* expire;
      if (!notification.threadId || !notification.loginId) return;
      const key = loginKey({ threadId: notification.threadId, server: notification.name });
      const entry = pending.get(key);
      if (!entry) return;
      if (entry.loginId === null) {
        // Native completion can precede the start RPC's response.
        pending.set(key, {
          ...entry,
          earlyCompletions: new Map(entry.earlyCompletions).set(
            notification.loginId,
            notification.success,
          ),
        });
      } else if (entry.loginId === notification.loginId) {
        yield* Deferred.succeed(entry.completion, notification.success);
      }
    }),
  );

  const status = Effect.fn("CodexMcpAuth.status")(
    function* (
      input: ServerInput,
    ): Effect.fn.Return<ThreadMcpServerStatus, CodexError.CodexAppServerError> {
      const response = yield* client.request("mcpServerStatus/list", {
        threadId: input.threadId,
        serverName: input.server,
        detail: "toolsAndAuthOnly",
      });
      const server = response.data.find((entry) => entry.name === input.server);
      if (!server) {
        return { name: input.server, status: "unknown", authStatus: "unknown", toolCount: 0 };
      }
      return {
        name: server.name,
        status: server.runtimeStatus == null ? "unknown" : connectionStatuses[server.runtimeStatus],
        authStatus: server.authStatus,
        toolCount: Object.keys(server.tools).length,
      };
    },
    Effect.mapError(
      (cause) =>
        new ProviderAdapterProtocolError({
          driver: CODEX_DRIVER_KIND,
          detail: "Failed to read Codex MCP server status",
          cause,
        }),
    ),
  );

  const login = Effect.fn("CodexMcpAuth.login")(function* (input: ServerInput) {
    yield* expire;
    const key = loginKey(input);
    const completion = yield* Deferred.make<boolean, ProviderAdapterMcpAuthError>();
    const expiresAt = (yield* Clock.currentTimeMillis) + LOGIN_TIMEOUT_SECS * 1_000;
    if (pending.has(key)) {
      return yield* new ProviderAdapterMcpAuthError({
        driver: CODEX_DRIVER_KIND,
        reason: "login-pending",
      });
    }
    pending.set(key, {
      ...input,
      loginId: null,
      expiresAt,
      completion,
      earlyCompletions: new Map(),
    });
    return yield* Effect.gen(function* () {
      const response = yield* client
        .request("mcpServer/oauth/login", {
          name: input.server,
          threadId: input.threadId,
          timeoutSecs: LOGIN_TIMEOUT_SECS,
        })
        .pipe(
          Effect.onError((cause) =>
            Effect.sync(() => {
              if (Cause.hasInterrupts(cause)) return;
              if (pending.get(key)?.completion === completion) pending.delete(key);
            }),
          ),
          Effect.timeout("30 seconds"),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProtocolError({
                driver: CODEX_DRIVER_KIND,
                detail: "Failed to start Codex MCP OAuth login",
                cause,
              }),
          ),
        );
      if (!response.loginId) {
        return yield* new ProviderAdapterMcpAuthVersionError({
          driver: CODEX_DRIVER_KIND,
        });
      }
      const entry = pending.get(key);
      if (entry?.completion !== completion) {
        return yield* new ProviderAdapterMcpAuthError({
          driver: CODEX_DRIVER_KIND,
          reason: "login-expired",
        });
      }
      pending.set(key, { ...entry, loginId: response.loginId, earlyCompletions: new Map() });
      const earlyCompletion = entry.earlyCompletions.get(response.loginId);
      if (earlyCompletion !== undefined) yield* Deferred.succeed(completion, earlyCompletion);
      return { loginId: response.loginId, authorizationUrl: response.authorizationUrl };
    });
  });

  const waitForLogin = Effect.fn("CodexMcpAuth.waitForLogin")(function* (
    input: ServerInput & { readonly loginId: string },
  ) {
    const key = loginKey(input);
    const entry = pending.get(key);
    yield* expire;
    if (!entry || entry.loginId !== input.loginId) {
      return yield* new ProviderAdapterMcpAuthError({
        driver: CODEX_DRIVER_KIND,
        reason: "login-not-found",
      });
    }
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.gen(function* () {
      if (entry.expiresAt <= now) {
        return yield* new ProviderAdapterMcpAuthError({
          driver: CODEX_DRIVER_KIND,
          reason: "login-expired",
        });
      }
      const success = yield* Deferred.await(entry.completion).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(Math.max(0, entry.expiresAt - now)),
          orElse: () =>
            Effect.fail(
              new ProviderAdapterMcpAuthError({
                driver: CODEX_DRIVER_KIND,
                reason: "login-expired",
              }),
            ),
        }),
      );
      if (!success)
        return yield* new ProviderAdapterMcpAuthError({
          driver: CODEX_DRIVER_KIND,
          reason: "login-failed",
        });
      return yield* status(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterMcpAuthError({
              driver: CODEX_DRIVER_KIND,
              reason: "status-check-failed",
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.hasInterrupts(exit)) return;
          if (pending.get(key)?.completion === entry.completion) pending.delete(key);
        }),
      ),
    );
  });

  return {
    status,
    login,
    waitForLogin,
    hasPendingLogin: (threadId?: string) =>
      Effect.gen(function* () {
        yield* expire;
        return [...pending.values()].some(
          (entry) => threadId === undefined || entry.threadId === threadId,
        );
      }),
  };
});
