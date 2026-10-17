import {
  ProviderThreadId,
  type ProviderInstanceId,
  ThreadId,
  type ThreadMcpLoginStarted,
  type ThreadMcpServerStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export class ThreadMcpError extends Schema.TaggedError<ThreadMcpError>()("ThreadMcpError", {
  threadId: ThreadId,
  reason: Schema.Literals([
    "session-stopped",
    "provider-unsupported",
    "provider-version-unsupported",
    "session-changed",
    "login-failed",
    "login-expired",
    "login-not-found",
    "login-pending",
    "status-check-failed",
    "request-failed",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "session-stopped":
        return "This chat has no active provider session. Send a message before managing its MCP server.";
      case "provider-unsupported":
        return "This chat's provider does not support native MCP sign-in through T3 Code.";
      case "provider-version-unsupported":
        return "Update this chat's provider to a version supporting correlated MCP OAuth sign-in, restart the agent session, and start sign-in again.";
      case "session-changed":
        return "The chat's provider session changed. Start MCP sign-in again in the current session.";
      case "login-failed":
        return "MCP sign-in did not complete successfully. Start sign-in again to retry.";
      case "login-expired":
        return "The MCP sign-in attempt expired. Start a new sign-in attempt.";
      case "login-not-found":
        return "No pending MCP sign-in matches this session, server, and login ID. The attempt may have expired; start sign-in again.";
      case "login-pending":
        return "MCP sign-in is already pending for this session and server. Finish or wait for the existing attempt before starting again.";
      case "status-check-failed":
        return "OAuth sign-in completed, but the MCP server status could not be verified. Check the server's status before using its tools.";
      case "request-failed":
        return "The native MCP request failed. Check the server's status and try again.";
    }
  }
}

interface Target {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly server: string;
}

export class ThreadMcpServers extends Context.Service<
  ThreadMcpServers,
  {
    readonly status: (input: Target) => Effect.Effect<ThreadMcpServerStatus, ThreadMcpError>;
    readonly login: (
      input: Target,
    ) => Effect.Effect<
      ThreadMcpLoginStarted & { readonly providerThreadId: ProviderThreadId },
      ThreadMcpError
    >;
    readonly waitForLogin: (
      input: Target & {
        readonly providerThreadId: ProviderThreadId;
        readonly loginId: string;
      },
    ) => Effect.Effect<ThreadMcpServerStatus, ThreadMcpError>;
  }
>()("t3/provider/ThreadMcpServers") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const resolve = Effect.fn("ThreadMcpServers.resolve")(function* (input: Target) {
    const records = yield* threads
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadMcpError({ threadId: input.threadId, reason: "request-failed", cause }),
        ),
      );
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === records.thread.activeProviderThreadId,
    );
    if (providerThread?.providerSessionId == null) {
      return yield* new ThreadMcpError({ threadId: input.threadId, reason: "session-stopped" });
    }
    if (providerThread.providerInstanceId !== input.providerInstanceId) {
      return yield* new ThreadMcpError({ threadId: input.threadId, reason: "session-changed" });
    }
    const runtime = Option.getOrUndefined(
      yield* sessions
        .get(providerThread.providerSessionId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ThreadMcpError({ threadId: input.threadId, reason: "request-failed", cause }),
          ),
        ),
    );
    if (runtime === undefined) {
      return yield* new ThreadMcpError({ threadId: input.threadId, reason: "session-stopped" });
    }
    if (runtime.mcpServers === undefined) {
      return yield* new ThreadMcpError({
        threadId: input.threadId,
        reason: "provider-unsupported",
      });
    }
    return { providerThread, runtime, mcpServers: runtime.mcpServers };
  });

  const status = Effect.fn("ThreadMcpServers.status")(function* (input: Target) {
    const resolved = yield* resolve(input);
    return yield* resolved.mcpServers
      .status({ providerThread: resolved.providerThread, server: input.server })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadMcpError({ threadId: input.threadId, reason: "request-failed", cause }),
        ),
      );
  });

  const login = Effect.fn("ThreadMcpServers.login")(function* (input: Target) {
    const resolved = yield* resolve(input);
    const started = yield* resolved.mcpServers
      .login({ providerThread: resolved.providerThread, server: input.server })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadMcpError({
              threadId: input.threadId,
              reason:
                cause._tag === "ProviderAdapterMcpAuthVersionError"
                  ? "provider-version-unsupported"
                  : cause._tag === "ProviderAdapterMcpAuthError"
                    ? cause.reason
                    : "request-failed",
              cause,
            }),
        ),
      );
    return { ...started, providerThreadId: resolved.providerThread.id };
  });

  const waitForLogin = Effect.fn("ThreadMcpServers.waitForLogin")(function* (
    input: Target & {
      readonly providerThreadId: ProviderThreadId;
      readonly loginId: string;
    },
  ) {
    const resolved = yield* resolve(input);
    if (resolved.providerThread.id !== input.providerThreadId) {
      return yield* new ThreadMcpError({ threadId: input.threadId, reason: "session-changed" });
    }
    const result = yield* resolved.mcpServers
      .waitForLogin({
        providerThread: resolved.providerThread,
        server: input.server,
        loginId: input.loginId,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadMcpError({
              threadId: input.threadId,
              reason:
                cause._tag === "ProviderAdapterMcpAuthError" ? cause.reason : "request-failed",
              cause,
            }),
        ),
      );
    const current = yield* resolve(input);
    if (
      current.providerThread.id !== resolved.providerThread.id ||
      current.runtime !== resolved.runtime ||
      current.providerThread.nativeThreadRef?.nativeId !==
        resolved.providerThread.nativeThreadRef?.nativeId
    ) {
      return yield* new ThreadMcpError({ threadId: input.threadId, reason: "session-changed" });
    }
    return result;
  });

  return ThreadMcpServers.of({ status, login, waitForLogin });
});

export const layer = Layer.effect(ThreadMcpServers, make);
