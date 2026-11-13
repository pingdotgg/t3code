import { pipe } from "effect/Function";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import type { CodexEffectiveRuntime } from "../../../provider/CodexManagedRuntime.ts";
import { CodexSettings, ProviderSetupError, type ServerProviderCompatibilityAdvisory } from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type { OrchestrationV2ProviderSession, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess } from "effect/process";
import * as PortScanner from "../../../preview/PortScanner.ts";
import { ServerConfig } from "../../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { materializeCodexShadowHome, resolveCodexHomeLayout } from "../../../provider/Drivers/CodexHomeLayout.ts";
import { boundProviderEventForLogging, shouldPersistProviderEvent } from "../../../provider/EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderAdapterDriverCreateError, type ProviderAdapterDriverCreateInput } from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexAppServerClientFactory, makeCodexAdapterV2 } from "../CodexAdapterV2.ts";
import { CODEX_PROVIDER, CODEX_CAPACITY_MAX_RETRIES, CODEX_DRIVER_KIND, CODEX_DEFAULT_INSTANCE_ID, codexFileChangeApprovalPrompt, canReuseCodexContextUsage, codexProviderTurnTokenUsage, CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS, CODEX_PLAN_DELTA_FLUSH_INTERVAL_MS, CodexBackgroundTerminalTerminateResponse, CodexBackgroundTerminalsListResponse, decodeCodexBackgroundTerminalTerminateResponse, decodeCodexBackgroundTerminalsListResponse, CODEX_CLIENT_CAPABILITIES, CodexProviderCapabilitiesV2, toProtocolError, CODEX_THREAD_IN_USE_MESSAGE, isCodexAppServerRequestError, isCodexActiveWriterError, codexTimestamp, codexUserMessageText, mapCodexTurnStatus, providerTurnStatusToTerminal, codexItemStatus, codexSkillMentionText, BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH, BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH, codexBackgroundCommandDetail, codexNativeSubagentLabel, codexNativeSubagentDetail, codexMcpToolOutput, MCP_APP_CAPTURE_TIMEOUT, codexMcpAppResourceUri, CODEX_IMAGE_DATA_URL, codexDynamicToolOutput, projectCodexDynamicToolItem, codexNativeItemRef, trimText, nonEmptyText, codexPlanStepStatus, approvalDecisionToLegacyReviewDecision, providerRequestKindFromPermissions, permissionsResponseFromDecision, answerValueToStrings, toCodexUserInputAnswers, compactStrings, webSearchPatterns, decodeTurnApprovalPolicy, decodeTurnSandboxPolicy, decodeTurnReasoningEffort, decodeCodexTurnStartParamsWithCollaborationMode, isProviderAdapterRuntimeRequestResponseError, type CodexFileChangeKinds, type CodexBackgroundTerminalsListPage, type CodexDynamicToolProjection, type CodexTurnStartParamsWithCollaborationMode, type CodexWebSearchItem, type CodexDynamicToolItem } from "./CodexProviderCapabilitiesV2.ts";
import { codexRuntimeModeTurnDefaults, buildCodexTurnStartParams, providerSession, getNativeThreadId, providerThreadFromCodexThread, isTerminalProviderTurn, CodexGoalObjectiveTooLongError, validateCodexGoalObjective, CODEX_GOAL_STATUSES, providerGoalFromCodex, providerGoalsEqual, describeCodexGoal, CODEX_GOAL_CONTINUATION_GRACE, providerTurnsForThread, countTerminalTurnsAfterBoundary, resolveCodexForkRollbackTurnCount, resolveCodexForkBoundary, CodexThreadHistoryMetadata, decodeCodexThreadHistoryMetadata, readCodexThreadHistoryMetadata, resolveCodexRollbackTurnCount, parseCodexRetryProgress, codexErrorInfoCode, codexExhaustionHttpStatus, codexUsageLimitError, withCodexManagedFailure, codexRetryTurnItem, isPersistentCodexDynamicTool, approvalOwnerCodexTurn, isDescendantCodexTurn, type CodexThreadGoal, type CodexErrorInfo, type ActiveCodexTurnContext, type ActiveCodexProviderRetry, type TrackedRunningCommandItem, type CodexRootTerminalEvent, type CodexGoalHold, type DeferredCodexRootTerminal, type CodexSubagentThreadContext, type PendingCodexSubagentTurnStarted, type PendingCodexRuntimeRequest, type CodexCollabAgentToolCallItem } from "./BuildCodexTurnStartParams.ts";

export type CodexSubAgentActivityItem = Extract<
| CodexSchema.V2ItemStartedNotification__ThreadItem
| CodexSchema.V2ItemCompletedNotification__ThreadItem,
{ readonly type: "subAgentActivity" }
>;

export interface CodexAppServerClientFactoryShape {
readonly open: (input: {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
}) => Effect.Effect<
  CodexClient.CodexAppServerClient["Service"],
  ProviderAdapter.ProviderAdapterOpenSessionError,
  Scope.Scope
>;
}

export const CODEX_THREAD_CONFIG = {
"tools.update_plan.enabled": true,
mcp_optional_startup_grace_ms: 10_000,
} as const;

export const CODEX_T3_MCP_TOOL_TIMEOUT_SEC = 65 * 60;

export const CODEX_T3_DIRECT_MCP_SERVER = "t3-code-direct";

export const CODEX_DIRECT_ONLY_T3_TOOL = "t3_thread_wait";

export function codexThreadRuntimeParams(input: {
readonly threadId: ThreadId | null;
readonly mcpSession: McpProviderSession.McpProviderSessionConfig | undefined;
readonly modelSelection?: { readonly model: string };
readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): {
readonly cwd?: string;
readonly model?: string;
readonly config: Readonly<Record<string, Schema.Json>>;
} {
const { mcpSession } = input;
const t3Server =
  mcpSession === undefined
    ? undefined
    : {
        url: mcpSession.endpoint,
        tool_timeout_sec: CODEX_T3_MCP_TOOL_TIMEOUT_SEC,
        http_headers: { Authorization: mcpSession.authorizationHeader },
      };
return {
  ...(input.runtimePolicy?.cwd == null ? {} : { cwd: input.runtimePolicy.cwd }),
  ...(input.modelSelection === undefined ? {} : { model: input.modelSelection.model }),
  config: {
    ...CODEX_THREAD_CONFIG,
    // One app-server serves many threads, so the id goes in per-thread shell config, not its env.
    ...(input.threadId === null
      ? {}
      : { [`shell_environment_policy.set.${PortScanner.AGENT_THREAD_ENV}`]: input.threadId }),
    ...(t3Server === undefined
      ? {}
      : {
          // Override only T3's servers so launch-argument MCP servers survive.
          "mcp_servers.t3-code": { ...t3Server, disabled_tools: [CODEX_DIRECT_ONLY_T3_TOOL] },
          // Code Mode runs a blocking wait as a nested call, and the model keeps working
          // around it. A second, direct-only registration makes it a plain tool call.
          [`mcp_servers.${CODEX_T3_DIRECT_MCP_SERVER}`]: {
            ...t3Server,
            enabled_tools: [CODEX_DIRECT_ONLY_T3_TOOL],
            omit_tools_from: ["code_mode", "deferred"],
          },
        }),
  },
};
}

export const decodeCodexResumeMetadata = Schema.decodeUnknownEffect(
Schema.Struct({ thread: Schema.Struct({ id: Schema.String, updatedAt: Schema.Number }) }),
);

export const CodexChildSelection = Schema.Struct({
thread: Schema.Struct({ id: Schema.String }),
model: Schema.NullOr(Schema.String),
reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
serviceTier: Schema.optional(Schema.NullOr(Schema.String)),
});

export const decodeCodexChildModel = Schema.decodeUnknownEffect(CodexChildSelection);

export const decodeCodexChildThread = Schema.decodeUnknownEffect(
Schema.Struct({
  thread: Schema.Struct({
    id: Schema.String,
    model: Schema.optional(Schema.NullOr(Schema.String)),
    reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
  }),
}),
);

export const makeCodexAppServerSpawnCommand = Effect.fn(
"CodexAdapterV2.makeCodexAppServerSpawnCommand",
)(function* (input: {
readonly command: string;
readonly args: ReadonlyArray<string>;
readonly cwd?: string | undefined;
readonly env?: NodeJS.ProcessEnv | undefined;
readonly extendEnv?: boolean | undefined;
readonly threadId?: string | undefined;
}) {
const launch = yield* (yield* AgentScope).wrap({
  command: input.command,
  args: input.args,
  name: "codex",
  threadId: input.threadId,
  env: input.env,
  shared: true,
});
const spawnCommand = yield* resolveSpawnCommand(launch.command, launch.args, {
  ...(input.env === undefined ? {} : { env: input.env }),
  ...(input.extendEnv === undefined ? {} : { extendEnv: input.extendEnv }),
});
return ChildProcess.make(spawnCommand.command, spawnCommand.args, {
  ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  ...(input.env === undefined ? {} : { env: input.env }),
  ...(input.extendEnv === undefined ? {} : { extendEnv: input.extendEnv }),
  shell: spawnCommand.shell,
});
});

export function makeCodexAppServerProtocolLogger(input: {
readonly nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger | undefined;
readonly threadId: ThreadId;
readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}): CodexClient.CodexAppServerClientOptions["logger"] | undefined {
const { nativeEventLogger } = input;
if (nativeEventLogger === undefined) {
  return undefined;
}

return (event) => {
  if (!shouldPersistProviderEvent("native", event)) return Effect.void;
  return nativeEventLogger
    .write(
      {
        provider: CODEX_PROVIDER,
        protocol: "codex.app-server",
        kind: "protocol",
        providerSessionId: input.providerSessionId,
        event: redactCodexProtocolValue(boundProviderEventForLogging(event)),
      },
      input.threadId,
    )
    .pipe(Effect.ignore);
};
}

export function redactCodexProtocolValue(value: unknown): unknown {
if (Array.isArray(value)) {
  return value.map(redactCodexProtocolValue);
}
if (value === null || typeof value !== "object") {
  if (typeof value !== "string") {
    return value;
  }
  if (/^Bearer\s+/i.test(value)) {
    return "[REDACTED]";
  }
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return value;
  }
  try {
    return pipe(
      JSON.parse(trimmed) as unknown,
      boundProviderEventForLogging,
      redactCodexProtocolValue,
      JSON.stringify,
    );
  } catch {
    return value;
  }
}
return Object.fromEntries(
  Object.entries(value).map(([key, nested]) => [
    key,
    isSensitiveCodexProtocolKey(key) ? "[REDACTED]" : redactCodexProtocolValue(nested),
  ]),
);
}

export function isSensitiveCodexProtocolKey(key: string): boolean {
const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
return (
  normalized.endsWith("authorization") ||
  normalized.endsWith("apikey") ||
  normalized.endsWith("token") ||
  normalized.endsWith("password") ||
  normalized.endsWith("secret")
);
}

export type CodexAdapterV2DriverEnv =
| CodexAppServerClientFactory
| Digest.Digest
| FileSystem.FileSystem
| IdAllocator.IdAllocatorV2
| McpProviderSessions.McpProviderSessions
| Path.Path
| ServerConfig;

export const createCodexAdapterV2 = Effect.fn("CodexAdapterV2.createCodexAdapterV2")(function* (
{ instanceId, environment, enabled, config }: ProviderAdapterDriverCreateInput<CodexSettings>,
hooks: Pick<CodexAdapterV2Options, "onUsageLimits" | "resolveRuntime" | "compatibility"> = {},
) {
const clientFactory = yield* CodexAppServerClientFactory;
const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
const digest = yield* Digest.Digest;
const fileSystem = yield* FileSystem.FileSystem;
const hostEnvironment = yield* HostProcess.Environment;
const idAllocator = yield* IdAllocator.IdAllocatorV2;
const serverConfig = yield* ServerConfig;
const homeLayout = yield* resolveCodexHomeLayout(config);

yield* materializeCodexShadowHome(homeLayout).pipe(
  Effect.mapError(
    (cause) =>
      new ProviderAdapterDriverCreateError({
        driver: CODEX_DRIVER_KIND,
        instanceId,
        detail: "Failed to materialize the Codex shadow home.",
        cause,
      }),
  ),
);

const settings = {
  ...config,
  enabled,
  binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
  homePath: homeLayout.effectiveHomePath ?? "",
} satisfies CodexSettings;

return yield* makeCodexAdapterV2({
  instanceId,
  settings,
  environment: yield* mergeProviderInstanceEnvironment(environment, hostEnvironment),
  clientFactory,
  digest,
  fileSystem,
  idAllocator,
  serverConfig,
  continuationRequests,
  ...hooks,
});
});

export interface CodexAdapterV2Options {
readonly instanceId: ProviderInstanceId;
readonly settings: CodexSettings;
readonly environment: NodeJS.ProcessEnv;
readonly clientFactory: CodexAppServerClientFactoryShape;
readonly onUsageLimits?: ManagedServerProvider["applyUsageLimits"];
readonly resolveRuntime?: Effect.Effect<CodexEffectiveRuntime, ProviderSetupError, Scope.Scope>;
readonly compatibility?: (
  version: string,
) => Effect.Effect<ServerProviderCompatibilityAdvisory | undefined>;
readonly digest: Digest.Digest["Service"];
readonly fileSystem: FileSystem.FileSystem;
readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
readonly serverConfig: ServerConfig["Service"];
/** Omitting this leaves late completions projection-only. */
readonly continuationRequests?: {
  readonly offer: (
    request: ProviderContinuationRequests.ProviderContinuationRequest,
  ) => Effect.Effect<void>;
};
}
