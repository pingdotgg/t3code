import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";

import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  copilotClientCapabilitiesMeta,
  extractCopilotSubagentUpdate,
  isCopilotLostSessionError,
  makeCopilotSubagentRouting,
} from "@t3tools/provider-acp-registry/server/copilotAcp";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { readCustomModelEntries } from "@t3tools/shared/model";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { resolveCommandPath } from "@t3tools/shared/shell";

import { GitHubCopilotSettings } from "../settings.ts";
import type { CopilotSdkMcpAppRequest } from "./copilotSdkRuntime.ts";
import {
  compactCopilotSdkSession,
  copilotSdkClosesAssistantMessage,
  copilotSdkForkFromTurn,
  copilotSdkMcpAppDocument,
  copilotSdkProposedPlan,
  copilotSdkSteering,
  makeCopilotSdkClient,
  makeCopilotSdkRuntime,
  requestCopilotSdkMcpApp,
  rollbackCopilotSdkSession,
  stopCopilotSdkTask,
} from "./copilotSdkRuntime.ts";

export const GITHUB_COPILOT_PROVIDER = ProviderDriverKind.make("githubCopilot");

const DEFAULT_SETTINGS = Schema.decodeSync(GitHubCopilotSettings)({});
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);

const GitHubCopilotProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
  planning: { ...AcpProviderCapabilitiesV2.planning, emitsProposedPlan: true },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    emitsSubagentLifecycle: true,
  },
  tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
  // An interrupt ends the main turn's running tool but leaves its background agents alive.
  turns: {
    ...AcpProviderCapabilitiesV2.turns,
    supportsActiveSteering: true,
    activeSteeringInterruptsTools: true,
    supportsSteeringByInterruptRestart: false,
  },
};

function makeCopilotSdkMcpApps(
  runtime: () => AcpSessionRuntime.AcpSessionRuntime["Service"],
): ProviderAdapter.ProviderAdapterV2McpApps {
  const request = (payload: CopilotSdkMcpAppRequest) =>
    requestCopilotSdkMcpApp(runtime(), payload).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapter.ProviderAdapterProtocolError({
            driver: GITHUB_COPILOT_PROVIDER,
            detail: `Copilot MCP App request failed: ${cause.message}`,
          }),
      ),
    );
  return {
    listTools: ({ server }) =>
      request({ operation: "listTools", server }).pipe(
        Effect.map((tools) => tools as ReadonlyArray<ProviderAdapter.ProviderAdapterV2McpTool>),
      ),
    callTool: ({ server, tool, arguments: toolArguments }) =>
      request({ operation: "callTool", server, tool, arguments: toolArguments }).pipe(
        Effect.map((result) => result as ProviderAdapter.ProviderAdapterV2McpCallToolResult),
      ),
    readResource: ({ server, uri }) =>
      request({ operation: "readResource", server, uri }).pipe(
        Effect.map((result) => result as { readonly contents: ReadonlyArray<unknown> }),
      ),
  };
}

function gitHubCopilotPromptFailure(cause: unknown) {
  return makeProviderFailure({
    cause,
    ...(isAcpRequestError(cause) ? { message: cause.errorMessage, code: String(cause.code) } : {}),
    class: "provider_error",
  });
}

export interface GitHubCopilotAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: GitHubCopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly selfInvocation: SelfInvocation;
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
}

function makeFlavor(options: GitHubCopilotAdapterV2Options): AcpAdapterV2Flavor {
  const routing = makeCopilotSubagentRouting();
  return {
    driver: GITHUB_COPILOT_PROVIDER,
    runtimeHarness: "GitHub Copilot",
    capabilities: GitHubCopilotProviderCapabilitiesV2,
    customModels: readCustomModelEntries(options.settings.customModels).map((entry) => entry.slug),
    clientCapabilitiesMeta: copilotClientCapabilitiesMeta,
    mcpOverHttp: true,
    promptFailure: gitHubCopilotPromptFailure,
    registerExtensions: routing.registerExtensions,
    normalizeSessionUpdate: routing.normalizeSessionUpdate,
    extractSubagentUpdate: extractCopilotSubagentUpdate,
    restartRuntimeAfterPromptError: isCopilotLostSessionError,
    reportsPerTurnPromptUsage: true,
    steering: copilotSdkSteering,
    closesAssistantMessage: copilotSdkClosesAssistantMessage,
    compactSession: compactCopilotSdkSession,
    forkFromTurn: copilotSdkForkFromTurn,
    proposedPlanMarkdown: copilotSdkProposedPlan,
    stopBackgroundTask: stopCopilotSdkTask,
    approvalFeedback: true,
    mcpAppDocument: (toolCall) =>
      copilotSdkMcpAppDocument(toolCall.data.meta, toolCall.data.rawOutput),
    mcpApps: makeCopilotSdkMcpApps,
    rollbackSession: rollbackCopilotSdkSession,
    makeRuntime:
      options.makeRuntime ??
      Effect.fnUntraced(function* (input: AcpAdapterV2RuntimeInput) {
        const { processEnvironment, ...runtimeInput } = input;
        const env = { ...options.environment, ...processEnvironment };
        const binary = options.settings.binaryPath || "copilot";
        // The SDK only checks that the file exists, so it never searches PATH itself.
        const command = yield* resolveCommandPath(binary, { env }).pipe(
          Effect.provideService(FileSystem.FileSystem, options.fileSystem),
          Effect.provideService(Path.Path, options.path),
        );
        if (command === null) {
          return yield* new AcpErrors.AcpSpawnError({ command: binary, cause: undefined });
        }
        return yield* makeCopilotSdkRuntime({
          ...runtimeInput,
          client: makeCopilotSdkClient({ command, args: [], env }),
        });
      }),
  };
}

export const makeGitHubCopilotAdapterV2 = Effect.fn("makeGitHubCopilotAdapterV2")(function* (
  options: GitHubCopilotAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
});

export type GitHubCopilotAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const GitHubCopilotAdapterV2Driver: ProviderAdapterDriver<
  GitHubCopilotSettings,
  GitHubCopilotAdapterV2DriverEnv
> = {
  driverKind: GITHUB_COPILOT_PROVIDER,
  configSchema: GitHubCopilotSettings,
  defaultConfig: (): GitHubCopilotSettings => DEFAULT_SETTINGS,
  create: Effect.fn("GitHubCopilotAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<GitHubCopilotSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeGitHubCopilotAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        selfInvocation,
        continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: GITHUB_COPILOT_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: GITHUB_COPILOT_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create the GitHub Copilot adapter.",
              cause,
            }),
        ),
      ),
  ),
};
