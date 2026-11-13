// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
// @effect-diagnostics anyUnknownInErrorContext:off
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  ForkSessionOptions,
  PermissionMode,
  Query as ClaudeQuery,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import * as HostProcess from "@t3tools/shared/HostProcess";

import type { OrchestrationV2ProviderSession, ThreadId } from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import * as Path from "effect/Path";

import * as Schema from "effect/Schema";

import * as ChildProcess from "effect/process/ChildProcess";

import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";

import {
  boundProviderEventForLogging,
  shouldPersistProviderEvent,
} from "../../provider/EventNdjsonLogger.ts";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CLAUDE_AGENT_SDK_QUERY_PROTOCOL } from "./ClaudeProviderIdentity.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { ClaudeAgentSdkQueryRunnerError } from "./ClaudeQueryRunnerTypes.ts";
import { ClaudeMcpRegistrationTimeoutError } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkQueryOptions } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeAgentSdkSessionForkInput } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeFlagSettings } from "./ClaudeQueryOptions.ts";

export const isClaudeAgentSdkQueryRunnerError = Schema.is(ClaudeAgentSdkQueryRunnerError);
export const isClaudeMcpRegistrationTimeoutError = Schema.is(ClaudeMcpRegistrationTimeoutError);
export const isProviderAdapterRuntimeRequestResponseError = Schema.is(
  ProviderAdapter.ProviderAdapterRuntimeRequestResponseError,
);
export const isProviderAdapterRollbackThreadError = Schema.is(
  ProviderAdapter.ProviderAdapterRollbackThreadError,
);

export function queryRunnerError(cause: unknown, method: string): ClaudeAgentSdkQueryRunnerError {
  return isClaudeAgentSdkQueryRunnerError(cause)
    ? cause
    : new ClaudeAgentSdkQueryRunnerError({ cause, method });
}

export function closeClaudeQuery(queryRuntime: ClaudeQuery) {
  return Effect.try({
    try: () => queryRuntime.close(),
    catch: (cause) => queryRunnerError(cause, "close"),
  });
}

// Iterate Query itself: the raw generator's return() queues behind a pending CLI read and deadlocks interruption.
export function claudeQueryMessages(queryRuntime: ClaudeQuery): AsyncIterable<SDKMessage, void> {
  return { [Symbol.asyncIterator]: () => queryRuntime };
}

export interface ClaudeAgentSdkLoggedQueryOptions {
  readonly model: ClaudeAgentSdkQueryOptions["model"];
  readonly tools: ClaudeAgentSdkQueryOptions["tools"];
  readonly permissionMode: ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly sessionId?: string;
  readonly resume?: string;
  readonly resumeSessionAt?: ClaudeAgentSdkQueryOptions["resumeSessionAt"];
  readonly cwd?: ClaudeAgentSdkQueryOptions["cwd"];
  readonly allowedTools?: ClaudeAgentSdkQueryOptions["allowedTools"];
  readonly disallowedTools?: ClaudeAgentSdkQueryOptions["disallowedTools"];
  readonly settingKeys?: ReadonlyArray<string>;
  readonly effort?: ClaudeAgentSdkQueryOptions["effort"];
  readonly includePartialMessages?: true;
  readonly pathToClaudeCodeExecutable?: ClaudeAgentSdkQueryOptions["pathToClaudeCodeExecutable"];
  readonly hasExtraArgs?: true;
  readonly allowDangerouslySkipPermissions?: true;
  readonly hasCanUseTool?: true;
  readonly hasEnvironment?: true;
  readonly hasMcpServers?: true;
}

export type ClaudeAgentSdkProtocolLogEvent =
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.open";
        readonly options: ClaudeAgentSdkLoggedQueryOptions;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "prompt.offer";
        readonly message: SDKUserMessage;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.set_model";
        readonly model: string;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.apply_flag_settings";
        readonly settings: ClaudeFlagSettings;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.set_permission_mode";
        readonly mode: PermissionMode;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.stop_task";
        readonly taskId: string;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.background_tasks";
        readonly toolUseId: string;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.interrupt";
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.close";
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "session.fork";
        readonly sessionId: string;
        readonly options: ForkSessionOptions;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "session.forked";
        readonly sessionId: string;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "subagent.lookup";
        readonly sessionId: string;
        readonly agentId: string;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "subagent.found";
        readonly toolUseId: string | null;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: SDKMessage;
    };

export type ClaudeAgentSdkProtocolLogger = (
  event: ClaudeAgentSdkProtocolLogEvent,
) => Effect.Effect<void>;

export function loggedClaudeQueryOptions(
  options: ClaudeAgentSdkQueryOptions,
): ClaudeAgentSdkLoggedQueryOptions {
  return {
    model: options.model,
    tools: options.tools,
    permissionMode: options.permissionMode,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.resumeSessionAt === undefined ? {} : { resumeSessionAt: options.resumeSessionAt }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
    ...(options.disallowedTools === undefined ? {} : { disallowedTools: options.disallowedTools }),
    // Settings can carry the user's --settings values, such as an env block with credentials.
    ...(typeof options.settings === "object" && options.settings !== null
      ? { settingKeys: Object.keys(options.settings) }
      : {}),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.includePartialMessages === true ? { includePartialMessages: true } : {}),
    ...(options.pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }),
    ...(options.extraArgs === undefined ? {} : { hasExtraArgs: true }),
    ...(options.allowDangerouslySkipPermissions === true
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(options.canUseTool === undefined ? {} : { hasCanUseTool: true }),
    ...(options.env === undefined ? {} : { hasEnvironment: true }),
    ...(options.mcpServers === undefined ? {} : { hasMcpServers: true }),
  };
}

export function makeClaudeAgentSdkProtocolLogger(input: {
  readonly nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}): ClaudeAgentSdkProtocolLogger | undefined {
  const { nativeEventLogger } = input;
  if (nativeEventLogger === undefined) {
    return undefined;
  }

  return (event) => {
    if (!shouldPersistProviderEvent("native", event)) return Effect.void;
    return nativeEventLogger
      .write(
        {
          provider: CLAUDE_PROVIDER,
          protocol: CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
          kind: "protocol",
          providerSessionId: input.providerSessionId,
          event: boundProviderEventForLogging(event),
        },
        input.threadId,
      )
      .pipe(Effect.ignore);
  };
}

export const encodeClaudeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const decodeClaudeHistoryFork = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ sessionId: Schema.String, headMessageId: Schema.optionalKey(Schema.String) }),
  ),
);

export const claudeConfigDirOf = (
  path: Path.Path,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
) => path.resolve(environment.CLAUDE_CONFIG_DIR ?? path.join(homeDirectory, ".claude"));

// The SDK reads CLAUDE_CONFIG_DIR from process.env. Isolate custom homes in a
// worker so concurrent providers keep the server's environment.
export const runClaudeWorker = Effect.fn("runClaudeWorker")(function* (input: {
  readonly method: "forkSession";
  readonly sessionId: string;
  readonly options?: ForkSessionOptions;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const path = yield* Path.Path;
  const fromSource = import.meta.url.endsWith(".ts");
  // A single executable hosts the worker itself; it has no sibling script.
  const workerArguments = (yield* HostProcess.IsExecutable)
    ? ["__claude-history"]
    : [
        ...(fromSource ? ["--experimental-strip-types"] : []),
        yield* path.fromFileUrl(
          new URL(
            fromSource ? "../../claude-history-worker.ts" : "./claude-history-worker.mjs",
            import.meta.url,
          ),
        ),
      ];
  const executablePath = yield* HostProcess.ExecutablePath;
  const result = yield* spawnAndCollect(
    executablePath,
    ChildProcess.make(
      executablePath,
      [...workerArguments, input.method, input.sessionId, encodeClaudeJson(input.options ?? {})],
      {
        env: {
          ...input.environment,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    ),
  ).pipe(Effect.timeout("30 seconds"));
  if (result.code !== 0) {
    return yield* new ClaudeAgentSdkQueryRunnerError({
      method: input.method,
      cause: result.stderr.trim() || `Claude history worker exited with code ${result.code}.`,
    });
  }
  return result.stdout;
});

export const forkClaudeSessionInWorker = Effect.fn("forkClaudeSessionInWorker")(function* (
  input: ClaudeAgentSdkSessionForkInput,
) {
  return yield* runClaudeWorker({ ...input, method: "forkSession" }).pipe(
    Effect.flatMap(decodeClaudeHistoryFork),
  );
});
