import { pipe } from "effect/Function";
import * as DocumentText from "../../provider/DocumentText.ts";
import { revertCodexThread } from "../../provider/CodexThreadRevert.ts";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { makeProviderTextDeltaCoalescer } from "./ProviderTextDeltaCoalescer.ts";
import {
  mcpToolPresentation,
  type McpToolPresentation,
} from "../../provider/CodexToolPresentation.ts";
import {
  makeCodexTurnTokenUsageState,
  getCodexTurnAccumulator,
  accumulateCodexTurnTokenUsage,
  completeCodexTurnTokenUsage,
  type CodexTurnTokenUsageState,
} from "../../provider/CodexTurnTokenUsage.ts";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import type { CodexEffectiveRuntime } from "../../provider/CodexManagedRuntime.ts";
import { classifyCodexManagedError } from "../../provider/CodexManagedErrors.ts";
import {
  buildCodexInitializeParams,
  codexAppServerEnvironment,
  codexDefaultReasoningEffortOverride,
} from "../../provider/CodexProvider.ts";
import {
  codexRateLimitsToUpdate,
  mergeCodexRateLimits,
  codexUsageLimitResetAt,
  type CodexRateLimitSnapshot,
} from "../../provider/codexUsageLimits.ts";
import {
  CodexSettings,
  defaultInstanceIdForDriver,
  isOrchestrationV2WorkActive,
  type OrchestrationV2GoalCommand,
  OrchestrationV2ProviderGoal,
  parseGoalCommand,
  ProviderDriverKind,
  ProviderSetupError,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  COMPUTER_USE_TOOL_SOURCE,
  dynamicToolSurface,
  dynamicToolTitle,
} from "@t3tools/shared/toolActivity";
import { getModelSelectionStringOptionValue, modelSelectionsEqual } from "@t3tools/shared/model";
import { appendGeneratedImageEmbeds } from "@t3tools/shared/generatedImageMarkdown";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type {
  ChatAttachment,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  ModelSelection,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2PlanStep,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderUserInputAnswers,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  ProviderThreadId,
  ProviderTurnId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Function from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { resolveAttachmentPath, resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as PortScanner from "../../preview/PortScanner.ts";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { buildCodexAdditionalContext } from "../../provider/CodexDeveloperInstructions.ts";
import {
  describeMcpElicitation,
  toMcpElicitationResponse,
} from "../../provider/CodexMcpElicitation.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../../provider/Drivers/CodexHomeLayout.ts";
import {
  boundProviderEventForLogging,
  shouldPersistProviderEvent,
} from "../../provider/EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_MIME_TYPE,
  MCP_APP_OUTPUT_KEY,
  MCP_APP_RESOURCE_SCHEME,
} from "@t3tools/shared/mcpApp";
import { snapshotMcpApp } from "../../mcpApps/McpAppSnapshot.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";


export * from "./CodexAdapterV2Prelude/BuildCodexTurnStartParams.ts";
export * from "./CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
export * from "./CodexAdapterV2Prelude/CreateCodexAdapterV2.ts";

import { CODEX_PROVIDER, CodexProviderCapabilitiesV2 } from "./CodexAdapterV2Prelude/CodexProviderCapabilitiesV2.ts";
import { type CodexAdapterV2Options, type CodexAppServerClientFactoryShape } from "./CodexAdapterV2Prelude/CreateCodexAdapterV2.ts";
import { makeCodexAppServerProtocolLogger, makeCodexAppServerSpawnCommand } from "./CodexAdapterV2Prelude/CreateCodexAdapterV2.ts";
import { installRegisterRootTurn } from "./CodexAdapterV2Parts/RegisterRootTurn.ts";
import { installEmitSubagentProviderTurnStarted } from "./CodexAdapterV2Parts/EmitSubagentProviderTurnStarted.ts";
import { installRegisterSubagentThread } from "./CodexAdapterV2Parts/RegisterSubagentThread.ts";
import { installBuildAgentMessageArtifacts } from "./CodexAdapterV2Parts/BuildAgentMessageArtifacts.ts";
import { installBuildUserInputRequestArtifacts } from "./CodexAdapterV2Parts/BuildUserInputRequestArtifacts.ts";
import { installEmitRootTerminal } from "./CodexAdapterV2Parts/EmitRootTerminal.ts";
import { installProjectGeneratedImages } from "./CodexAdapterV2Parts/ProjectGeneratedImages.ts";
import { installMakeRootTerminalEvent } from "./CodexAdapterV2Parts/MakeRootTerminalEvent.ts";
import { installFinalizeCodexTurn } from "./CodexAdapterV2Parts/FinalizeCodexTurn.ts";
import { installRetryCapacityFailure } from "./CodexAdapterV2Parts/RetryCapacityFailure.ts";
import { installRuntimeThreadControl } from "./CodexAdapterV2Parts/RuntimeThreadControl.ts";
import { installRuntimeInterrupt } from "./CodexAdapterV2Parts/RuntimeInterrupt.ts";
import { installRuntimeThreadLifecycle } from "./CodexAdapterV2Parts/RuntimeThreadLifecycle.ts";

export class CodexAppServerClientFactory extends Context.Service<
  CodexAppServerClientFactory,
  CodexAppServerClientFactoryShape
>()("t3/orchestration-v2/Adapters/CodexAdapterV2/CodexAppServerClientFactory") {}

export const layerAppServerClientFactory: Layer.Layer<
  CodexAppServerClientFactory,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | PortScanner.PortDiscovery
  | ProviderEventLoggers.ProviderEventLoggers
> = Layer.effect(
  CodexAppServerClientFactory,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { native: nativeEventLogger } = yield* ProviderEventLoggers.ProviderEventLoggers;
    const agentScope = yield* AgentScope;
    const portDiscovery = yield* PortScanner.PortDiscovery;

    return CodexAppServerClientFactory.of({
      open: Effect.fn("CodexAdapterV2.open")(function* (input) {
        const scope = yield* Scope.Scope;
        const environment = {
          ...codexAppServerEnvironment(input.environment),
          ...(input.settings.homePath ? { CODEX_HOME: input.settings.homePath } : {}),
        };
        const command = yield* makeCodexAppServerSpawnCommand({
          command: input.settings.binaryPath || "codex",
          args: codexAppServerArgs(
            resolveCodexLaunchArgs(input.settings.launchArgs, input.environment),
          ),
          env: environment,
          threadId: input.threadId,
        }).pipe(Effect.provideService(AgentScope, agentScope));
        const handle = yield* spawner.spawn(command).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CODEX_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
        // Its shells carry each thread's T3CODE_THREAD_ID, so port discovery reads listeners' threads.
        yield* Effect.acquireRelease(Effect.sync(portDiscovery.trackAgent), (release) =>
          Effect.sync(release),
        );
        const protocolLogger = makeCodexAppServerProtocolLogger({
          nativeEventLogger,
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        });
        const clientOptions: CodexClient.CodexAppServerClientOptions =
          protocolLogger === undefined
            ? {}
            : {
                logIncoming: true,
                logOutgoing: true,
                logger: protocolLogger,
              };
        const context = yield* Layer.build(CodexClient.layerChildProcess(handle, clientOptions));
        return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(context),
        );
      }),
    });
  }),
);

export type CodexAdapterScope = {
  readonly adapterOptions: CodexAdapterV2Options;
  readonly clientFactory: CodexAdapterV2Options["clientFactory"];
  readonly continuationRequests: CodexAdapterV2Options["continuationRequests"];
  readonly digest: CodexAdapterV2Options["digest"];
  readonly fileSystem: CodexAdapterV2Options["fileSystem"];
  readonly idAllocator: CodexAdapterV2Options["idAllocator"];
  readonly serverConfig: CodexAdapterV2Options["serverConfig"];
  readonly mcpSessions: (typeof McpProviderSessions.McpProviderSessions)["Service"];
  readonly readMcpSession: (threadId: ThreadId | null) => Effect.Effect<Effect.Success<ReturnType<(typeof McpProviderSessions.McpProviderSessions)["Service"]["read"]>> | undefined, Effect.Error<ReturnType<(typeof McpProviderSessions.McpProviderSessions)["Service"]["read"]>>>;
  readonly input: Parameters<ProviderAdapter.ProviderAdapterV2["Service"]["openSession"]>[0];
};

export const makeCodexAdapterV2 = Effect.fn("makeCodexAdapterV2")(function* (
  adapterOptions: CodexAdapterV2Options,
) {
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const readMcpSession = (threadId: ThreadId | null) =>
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
    threadId === null ? Effect.succeed(undefined) : mcpSessions.read(threadId);
  const { clientFactory, digest, fileSystem, idAllocator, serverConfig } = adapterOptions;
  const continuationRequests = adapterOptions.continuationRequests;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: adapterOptions.instanceId,
    driver: CODEX_PROVIDER,
    getCapabilities: Effect.fn("CodexAdapterV2.getCapabilities")(function () {
      return Effect.succeed(CodexProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("CodexAdapterV2.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("CodexAdapterV2.openSession")(
      function* (input) {
      const RegisterRootTurn = yield* installRegisterRootTurn({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input });
      const EmitSubagentProviderTurnStarted = yield* installEmitSubagentProviderTurnStarted({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input, ...RegisterRootTurn });
      const RegisterSubagentThread = yield* installRegisterSubagentThread({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input, ...RegisterRootTurn, ...EmitSubagentProviderTurnStarted });
      const BuildAgentMessageArtifacts = yield* installBuildAgentMessageArtifacts({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input, ...RegisterRootTurn, ...EmitSubagentProviderTurnStarted, ...RegisterSubagentThread });
      const BuildUserInputRequestArtifacts = yield* installBuildUserInputRequestArtifacts({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input, ...RegisterRootTurn, ...EmitSubagentProviderTurnStarted, ...RegisterSubagentThread, ...BuildAgentMessageArtifacts });
      const EmitRootTerminal = yield* installEmitRootTerminal({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input, ...RegisterRootTurn, ...EmitSubagentProviderTurnStarted, ...RegisterSubagentThread, ...BuildAgentMessageArtifacts, ...BuildUserInputRequestArtifacts });
      const ProjectGeneratedImages = yield* installProjectGeneratedImages({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input, ...RegisterRootTurn, ...EmitSubagentProviderTurnStarted, ...RegisterSubagentThread, ...BuildAgentMessageArtifacts, ...BuildUserInputRequestArtifacts, ...EmitRootTerminal });
      const MakeRootTerminalEvent = yield* installMakeRootTerminalEvent({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input, ...RegisterRootTurn, ...EmitSubagentProviderTurnStarted, ...RegisterSubagentThread, ...BuildAgentMessageArtifacts, ...BuildUserInputRequestArtifacts, ...EmitRootTerminal, ...ProjectGeneratedImages });
      const FinalizeCodexTurn = yield* installFinalizeCodexTurn({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input, ...RegisterRootTurn, ...EmitSubagentProviderTurnStarted, ...RegisterSubagentThread, ...BuildAgentMessageArtifacts, ...BuildUserInputRequestArtifacts, ...EmitRootTerminal, ...ProjectGeneratedImages, ...MakeRootTerminalEvent });
      const RetryCapacityFailure = yield* installRetryCapacityFailure({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input, ...RegisterRootTurn, ...EmitSubagentProviderTurnStarted, ...RegisterSubagentThread, ...BuildAgentMessageArtifacts, ...BuildUserInputRequestArtifacts, ...EmitRootTerminal, ...ProjectGeneratedImages, ...MakeRootTerminalEvent, ...FinalizeCodexTurn });
      const RuntimeThreadControl = yield* installRuntimeThreadControl({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input, ...RegisterRootTurn, ...EmitSubagentProviderTurnStarted, ...RegisterSubagentThread, ...BuildAgentMessageArtifacts, ...BuildUserInputRequestArtifacts, ...EmitRootTerminal, ...ProjectGeneratedImages, ...MakeRootTerminalEvent, ...FinalizeCodexTurn, ...RetryCapacityFailure });
      const RuntimeInterrupt = yield* installRuntimeInterrupt({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input, ...RegisterRootTurn, ...EmitSubagentProviderTurnStarted, ...RegisterSubagentThread, ...BuildAgentMessageArtifacts, ...BuildUserInputRequestArtifacts, ...EmitRootTerminal, ...ProjectGeneratedImages, ...MakeRootTerminalEvent, ...FinalizeCodexTurn, ...RetryCapacityFailure, ...RuntimeThreadControl });
      const RuntimeThreadLifecycle = yield* installRuntimeThreadLifecycle({ adapterOptions, clientFactory, continuationRequests, digest, fileSystem, idAllocator, serverConfig, mcpSessions, readMcpSession, input, ...RegisterRootTurn, ...EmitSubagentProviderTurnStarted, ...RegisterSubagentThread, ...BuildAgentMessageArtifacts, ...BuildUserInputRequestArtifacts, ...EmitRootTerminal, ...ProjectGeneratedImages, ...MakeRootTerminalEvent, ...FinalizeCodexTurn, ...RetryCapacityFailure, ...RuntimeThreadControl, ...RuntimeInterrupt });
      const { runtime, scope } = { ...RegisterRootTurn, ...EmitSubagentProviderTurnStarted, ...RegisterSubagentThread, ...BuildAgentMessageArtifacts, ...BuildUserInputRequestArtifacts, ...EmitRootTerminal, ...ProjectGeneratedImages, ...MakeRootTerminalEvent, ...FinalizeCodexTurn, ...RetryCapacityFailure, ...RuntimeThreadControl, ...RuntimeInterrupt, ...RuntimeThreadLifecycle };
return runtime;
    },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CODEX_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
});
