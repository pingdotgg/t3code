import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as PeerLinkRequests from "./peer/PeerLinkRequests.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Base64 from "effect/encoding/Base64";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { rpcInitialItems } from "./rpcInitialItems.ts";
import { subscribeChatGptHandoff } from "./provider/CodexChatGptHandoff.ts";
import {
  AcpRegistryOperationError,
  CommandId,
  authScopeResponse,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  type ScheduledTaskListResult,
  AuthSessionId,
  ClientConnectionMethod,
  ClientDeviceType,
  ClientOs,
  ClientSurface,
  ClientWebDeployment,
  type DiscoveredLocalServerList,
  type EditorId,
  type FileManagerRevealKind,
  type OrchestrationV2Command,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  type MessageId,
  type AcpRegistryImportSessionInput,
  type AcpRegistryDeleteSessionInput,
  type AcpRegistryDisableProviderInput,
  type AcpRegistryListProvidersInput,
  type AcpRegistryListSessionsInput,
  type AcpRegistrySetProviderInput,
  OrchestrationGetFullThreadDiffError,
  OrchestrationSearchThreadsError,
  OrchestrationV2SearchThreadError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_V2_WS_METHODS,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadStreamItem,
  type ApplicationStoredEvent,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  type ProjectMutation,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ProjectMutationError,
  ProviderUploadFeedbackError,
  ProviderSetupError,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  type ServerConfig as ClientServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerProvider,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  SOURCE_CONTROL_MEDIA_ASSET,
  ChatAttachmentId,
  PersistChatAttachmentsError,
  RpcClientId,
  EnvironmentAuthorizationError,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  ThreadId,
  type TerminalMetadataStreamEvent,
  type PullRequestRef,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import { RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "./orchestration-v2/ThreadMessageIntake.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as GuestShareService from "./guest/GuestShareService.ts";
import {
  bufferShellLiveStream,
  coalesceShellApplicationEvents,
  composeShellStreamWithEnrichment,
  dedupeShellEnrichment,
  loadOlderSettledThreadsPage,
  loadShellSnapshotParts,
  shellStreamItemFromEnrichmentRefresh,
  shellStreamItemFromThreadShell,
  shellStreamItemsFromInitialSnapshot,
  loadSubscriberShellSnapshot,
  shellStreamItemsFromResumeSnapshot,
  shouldPublishShellApplicationEvent,
  skipUnchangedThreadShells,
  toShellApplicationEvent,
  type ShellApplicationEvent,
} from "./orchestration-v2/ShellStream.ts";
import { ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION } from "./orchestration-v2/ProjectionStore.ts";
import {
  coalesceLiveUpdatedEvents,
  coalesceThreadLiveStream,
} from "./orchestration-v2/ThreadLiveEventCoalescer.ts";
import {
  buildBoundedThreadStreamSnapshot,
  decideThreadResume,
  isThreadReplayRawPayloadSafe,
  threadReplayEncodedBytes,
  THREAD_RESUME_MAX_REPLAY_EVENTS,
} from "./orchestration-v2/ThreadStream.ts";
import {
  buildBoundedThreadProjection,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./orchestration-v2/threadHistoryPaging.ts";
import {
  makeLiveBodyDeduper,
  projectDomainEventForWire,
  projectThreadProjectionForWire,
} from "./orchestration-v2/WireProjection.ts";
import { dedupeSnapshotBodies } from "@t3tools/shared/orchestrationV2DedupedBodies";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import { userFacingDispatchErrorMessage } from "./orchestration-v2/UserFacingErrors.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { latestProviderVersionCacheKeys } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import { makeProviderInstallation } from "./provider/providerInstallation.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { terminalOutputStream, withTerminalOutputWindow } from "./terminal/OutputProtocol.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as DeviceService from "./device/DeviceService.ts";
import { remoteSshDeviceHosts } from "./device/localSshDeviceHost.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import {
  attachmentRelativePath,
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { deletePendingAttachment, issueAttachmentUploadUrl } from "./assets/AttachmentUpload.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as KnownWorkspaces from "./workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import { readWorkflowScript } from "./orchestration-v2/workflowScriptQuery.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import { refreshPushedPullRequests } from "./git/refreshPushedPullRequests.ts";
import { linkCreatedPullRequest } from "./git/linkCreatedPullRequest.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import { threadWorkspaceRoot } from "./project/threadWorkspaceRoot.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import { projectMutationOperation } from "./project/ProjectMutation.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as DefectReporter from "./observability/DefectReporter.ts";
import * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { requiredScopeForDeviceList, rpcAuthorizationError } from "./auth/RpcAuthorization.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import { RpcInstrumentation, rpcInstrumentationLayer } from "./observability/RpcInstrumentation.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import { commandFeatureUsage, featureUsage } from "./telemetry/FeatureUsage.ts";
import type { TelemetryOwner } from "./telemetry/Identify.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import { listLinkedPullRequestThreads } from "./pullRequest/linkedThreads.ts";
import { pullRequestSyncKey } from "./pullRequest/pullRequestSyncKey.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import { isNetworkPath } from "@t3tools/shared/path";
import * as RelayClient from "@t3tools/shared/relayClient";
import { isTelemetryIdHash } from "@t3tools/shared/telemetryId";
import {
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
} from "@t3tools/shared/usageLimits";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import { legacyCreditSettings, legacyCreditSources } from "./usage/creditClientCompatibility.ts";

const CONFIG_DISCOVERY_TIMEOUT = Duration.seconds(5);
const isProviderUploadFeedbackError = Schema.is(ProviderUploadFeedbackError);

const resolveDiscoveryForConfig = <A, E, R>(
  discovery: Effect.Effect<A, E, R>,
  onTimeout: () => A,
) =>
  discovery.pipe(
    Effect.timeoutOption(CONFIG_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(onTimeout)),
  );

const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) => resolveDiscoveryForConfig(discovery, () => []);

const resolveFileManagerRevealKindForConfig = <E, R>(
  discovery: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) => resolveDiscoveryForConfig(discovery, () => undefined);

type EditorDiscovery = Pick<
  ExternalLauncher.ExternalLauncher["Service"],
  "resolveAvailableEditors" | "resolveFileManagerRevealKind"
>;

const resolveEditorConfig = Effect.fn("ws.resolveEditorConfig")(function* <E, R>(
  availableEditors: ReadonlyArray<EditorId>,
  revealKind: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) {
  const fileManagerRevealKind = availableEditors.includes("file-manager")
    ? yield* revealKind
    : undefined;
  return {
    availableEditors,
    ...(fileManagerRevealKind === undefined
      ? {}
      : {
          shellRevealInFileManager: true,
          shellRevealInFileManagerKind: fileManagerRevealKind,
        }),
  };
});

export const withLateEditorConfig = <E, R>(
  config: ClientServerConfig,
  liveUpdates: Stream.Stream<ServerConfigStreamEvent, E, R>,
  launcher: EditorDiscovery,
) => {
  const lateEditorConfig = Stream.fromEffect(launcher.resolveAvailableEditors()).pipe(
    Stream.filter(
      (editors) =>
        editors.join() !== config.availableEditors.join() ||
        (editors.includes("file-manager") && config.shellRevealInFileManagerKind === undefined),
    ),
    // Leave the unshared reveal probe unbounded so timeouts cannot cancel every attempt on slow hosts.
    Stream.mapEffect((editors) =>
      resolveEditorConfig(editors, launcher.resolveFileManagerRevealKind()),
    ),
    Stream.filter(
      (editorConfig) =>
        editorConfig.availableEditors.join() !== config.availableEditors.join() ||
        editorConfig.shellRevealInFileManagerKind !== config.shellRevealInFileManagerKind,
    ),
    Stream.map((editorConfig) => ({ type: "editorsResolved" as const, editorConfig })),
  );

  return Stream.merge(liveUpdates, lateEditorConfig).pipe(
    Stream.mapAccum(
      (): ClientServerConfig => config,
      (current, event): readonly [ClientServerConfig, ReadonlyArray<ServerConfigStreamEvent>] => {
        switch (event.type) {
          case "editorsResolved": {
            const {
              availableEditors: _editors,
              shellRevealInFileManager: _reveal,
              shellRevealInFileManagerKind: _revealKind,
              ...rest
            } = current;
            const next = { ...rest, ...event.editorConfig };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
          case "keybindingsUpdated":
            return [{ ...current, ...event.payload }, [event]];
          case "providerStatuses":
            return [{ ...current, providers: event.payload.providers }, [event]];
          case "settingsUpdated":
            return [{ ...current, settings: event.payload.settings }, [event]];
          // Themes and usage-limit sources survive snapshots because snapshots never include them.
          default:
            return [current, [event]];
        }
      },
    ),
  );
};

function withoutWorkspaceSnapshots(providers: ReadonlyArray<ServerProvider>): ServerProvider[] {
  return providers.map(({ workspaceSnapshots: _workspaceSnapshots, ...provider }) => provider);
}

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

const persistChatAttachments = Effect.fn("ws.assets.persistChatAttachments")(function* (input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly attachments: ReadonlyArray<{
    readonly type: "image";
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly dataUrl: string;
  }>;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(
    input.attachments.map((attachment, index) => ({ attachment, index })),
    Effect.fn("ws.assets.persistChatAttachment")(function* ({ attachment, index }) {
      const parsed = parseBase64DataUrl(attachment.dataUrl);
      if (parsed === null || parsed.mimeType !== attachment.mimeType.toLowerCase()) {
        return yield* new PersistChatAttachmentsError({
          message: `Attachment ${attachment.name} has an invalid image payload.`,
        });
      }
      const bytes = yield* Effect.fromResult(Base64.decode(parsed.base64)).pipe(
        Effect.mapError(
          (cause) =>
            new PersistChatAttachmentsError({
              message: `Attachment ${attachment.name} is not valid base64.`,
              cause,
            }),
        ),
      );
      if (bytes.byteLength !== attachment.sizeBytes) {
        return yield* new PersistChatAttachmentsError({
          message: `Attachment ${attachment.name} size does not match its payload.`,
        });
      }
      const rawId = createDeterministicAttachmentId(
        input.threadId,
        chatAttachmentStableKey(input.messageId, index, bytes),
      );
      if (rawId === null) {
        return yield* new PersistChatAttachmentsError({
          message: "Could not allocate an attachment identifier.",
        });
      }
      const persisted = {
        type: "image" as const,
        id: ChatAttachmentId.make(rawId),
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
      yield* fileSystem
        .writeFile(path.join(config.attachmentsDir, attachmentRelativePath(persisted)!), bytes)
        .pipe(
          Effect.mapError(
            (cause) =>
              new PersistChatAttachmentsError({
                message: `Could not persist attachment ${attachment.name}.`,
                cause,
              }),
          ),
        );
      return persisted;
    }),
    { concurrency: 2 },
  );
});

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "directory_list_failed",
        ...(error.cwd !== undefined ? { normalizedCwd: error.cwd } : {}),
        detail: error.message,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError
    | KnownWorkspaces.UnknownWorkspaceError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
    case "UnknownWorkspaceError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// Middleware added later wraps middleware added earlier, so instrumentation wraps authorization.
const ServerWsRpcGroup = WsRpcGroup.middleware(RpcInstrumentation);

// RpcGroup.toLayer derives each handler's requirements by scanning every RPC in
// the group, so its type cost grows with handlers × RPCs. Near 200 methods that
// crosses TypeScript's instantiation limit and the layer's requirements degrade to
// `any`, so the handlers are registered as two disjoint, smaller groups.
type ServerWsRpc = RpcGroup.Rpcs<typeof ServerWsRpcGroup>;
const SPLIT_WS_RPC_PREFIXES = ["server", "pullRequests", "provider", "orchestration"] as const;
type SplitWsRpc = Extract<
  ServerWsRpc,
  { readonly _tag: `${(typeof SPLIT_WS_RPC_PREFIXES)[number]}.${string}` }
>;
const isSplitWsRpc = (rpc: ServerWsRpc): rpc is SplitWsRpc =>
  SPLIT_WS_RPC_PREFIXES.some((prefix) => rpc._tag.startsWith(`${prefix}.`));
const isOtherWsRpc = (rpc: ServerWsRpc): rpc is Exclude<ServerWsRpc, SplitWsRpc> =>
  !isSplitWsRpc(rpc);
const serverWsRpcs = Array.from(ServerWsRpcGroup.requests.values());
const SplitWsRpcGroup = RpcGroup.make(...serverWsRpcs.filter(isSplitWsRpc));
const OtherWsRpcGroup = RpcGroup.make(...serverWsRpcs.filter(isOtherWsRpc));
// Replaying each intervening event costs a shell refetch; past this gap a
// single O(active-threads) snapshot is cheaper and bounded.
const SHELL_RESUME_MAX_GAP = 1_000;
// Row counts do not bound large tool payloads; sum stored JSON bytes in SQL and snapshot above budget.
const ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024;

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: { ...change.pairingLink, ...authScopeResponse(change.pairingLink.scopes) },
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          ...authScopeResponse(change.clientSession.scopes),
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const isClientSurface = Schema.is(ClientSurface);
const isClientConnectionMethod = Schema.is(ClientConnectionMethod);
const isClientDeviceType = Schema.is(ClientDeviceType);
const isClientOs = Schema.is(ClientOs);
const isClientWebDeployment = Schema.is(ClientWebDeployment);
const MAX_CLIENT_APP_VERSION_LENGTH = 64;
const MAX_CLIENT_BROWSER_LENGTH = 64;
const MAX_CLIENT_DEVICE_MODEL_LENGTH = 80;

function hasCompatibleOrchestrationProtocol(url: URL): boolean {
  return (
    url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) ===
    String(ORCHESTRATION_PROTOCOL_VERSION)
  );
}

function shouldUseBoundedThreadSnapshot(input: {
  readonly acceptBoundedSnapshot?: boolean;
  readonly acceptDeferredWork?: boolean;
}): boolean {
  return input.acceptBoundedSnapshot === true;
}

// Keep telemetry per socket; several client types can connect simultaneously.
function readClientAnalyticsProps(request: HttpServerRequest.HttpServerRequest) {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return {};
  }

  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  const deviceType = url.value.searchParams.get("clientDeviceType");
  const os = url.value.searchParams.get("clientOs");
  const webDeployment = url.value.searchParams.get("clientWebDeployment");
  const browser = url.value.searchParams.get("clientBrowser")?.trim() ?? "";
  const connectionMethod = url.value.searchParams.get("connectionMethod");
  const rawOsMajorVersion = url.value.searchParams.get("clientOsMajorVersion") ?? "";
  const osMajorVersion = Number(rawOsMajorVersion);
  const deviceModel = url.value.searchParams.get("clientDeviceModel")?.trim() ?? "";
  const isMobile = surface === "mobile";
  const hasOsMajorVersion =
    isMobile && rawOsMajorVersion !== "" && Number.isInteger(osMajorVersion) && osMajorVersion > 0;
  const hasDeviceModel =
    isMobile && deviceModel !== "" && deviceModel.length <= MAX_CLIENT_DEVICE_MODEL_LENGTH;

  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion, clientAppVersion: appVersion }
      : {}),
    ...(isClientOs(os)
      ? {
          clientOs: os,
          ...(isMobile && (os === "iOS" || os === "Android") ? { os } : {}),
        }
      : {}),
    ...(isClientDeviceType(deviceType) ? { clientDeviceType: deviceType } : {}),
    ...(surface === "web" && isClientWebDeployment(webDeployment) ? { webDeployment } : {}),
    ...(surface === "web" && browser !== "" && browser.length <= MAX_CLIENT_BROWSER_LENGTH
      ? { clientBrowser: browser }
      : {}),
    ...(hasOsMajorVersion ? { osMajorVersion, clientOsMajorVersion: osMajorVersion } : {}),
    ...(hasDeviceModel ? { deviceModel, clientDeviceModel: deviceModel } : {}),
    ...(isClientConnectionMethod(connectionMethod) ? { connectionMethod } : {}),
  };
}

/**
 * Owners a connecting client reports: its hashed T3 Connect account and its
 * hashed device id. Only hashes are accepted, so a raw id never reaches analytics.
 */
function readClientOwners(
  request: HttpServerRequest.HttpServerRequest,
): ReadonlyArray<TelemetryOwner> {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return [];
  }
  const params = url.value.searchParams;
  return (
    [
      ["connect", params.get("clientOwner")],
      ["device", params.get("clientDevice")],
    ] as const
  ).flatMap(([source, ownerId]) =>
    ownerId !== null && isTelemetryIdHash(ownerId) ? [{ source, ownerId }] : [],
  );
}

const canReplayPersistedRange = Effect.fnUntraced(function* (
  afterSequence: number,
  headSequence: number,
  maxGap: number,
) {
  const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;

  const replayGap = headSequence - afterSequence;
  if (replayGap < 0 || replayGap > maxGap) {
    return false;
  }
  const stats = yield* applicationEvents.getReplayStats({
    afterSequence,
    throughSequence: headSequence,
  });
  if (stats.rawPayloadBytes > ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES) {
    yield* Effect.logDebug("orchestration replay replaced by snapshot", {
      afterSequence,
      headSequence,
      replayGap,
      eventCount: stats.eventCount,
      payloadBytes: stats.rawPayloadBytes,
      payloadBudgetBytes: ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES,
    });
    return false;
  }
  return true;
});

const enrichProjectShells = Effect.fn("ws.orchestrationV2.enrichProjectShells")(
  (projects: ReadonlyArray<OrchestrationProjectShell>) =>
    Effect.flatMap(ProjectEnrichmentService.ProjectEnrichmentService, (projectEnrichment) =>
      Effect.forEach(
        projects,
        (project) =>
          projectEnrichment.getAvailable(project.workspaceRoot).pipe(
            Effect.map((enrichment) => ({
              project: {
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              },
              repositoryIdentityResolved: enrichment.repositoryIdentityResolved,
            })),
          ),
        { concurrency: 16 },
      ).pipe(
        Effect.map((enriched) => ({
          projects: enriched.map((entry) => entry.project),
          resolvedRepositoryIdentityRoots: enriched
            .filter((entry) => entry.repositoryIdentityResolved)
            .map((entry) => entry.project.workspaceRoot),
        })),
      ),
    ),
);

export const subscribeOrchestrationV2Thread = Effect.fn("ws.orchestrationV2.subscribeThread")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly afterSequence?: number;
    readonly requestCompletionMarker?: boolean;
    readonly acceptBoundedSnapshot?: boolean;
    readonly acceptDeferredWork?: boolean;
    readonly acceptCompactTurnItems?: boolean;
    readonly acceptDedupedBodies?: boolean;
    readonly acceptCompactIds?: boolean;
  }) {
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const dedupeBodies = input.acceptDedupedBodies === true;
    // Replay, snapshot, and live tail share one deduper: it must see every delivered record.
    const withLiveDedupe = <E, R>(stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>) =>
      dedupeBodies ? Stream.suspend(() => Stream.map(stream, makeLiveBodyDeduper())) : stream;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;

    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
    });
    yield* threadManagement.ensureLegacyTranscript(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetThreadProjectionError({
            threadId: input.threadId,
            message: `Failed to hydrate migrated thread ${input.threadId}`,
            cause,
          }),
      ),
    );

    const eventStreamFrom = (afterSequence: number) =>
      threadManagement
        .streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
        })
        .pipe(
          Stream.map((stored) => ({
            kind: "event" as const,
            sequence: stored.sequence,
            event: projectDomainEventForWire(stored.event),
          })),
          coalesceThreadLiveStream,
          Stream.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed while streaming orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );

    const loadReplayThrough = (afterSequence: number, throughSequence: number) =>
      applicationEvents
        .readAgentEvents({
          threadId: input.threadId,
          afterSequence,
          throughSequence,
          limit: THREAD_RESUME_MAX_REPLAY_EVENTS + 1,
          // Downgrades can leave unknown rows; skip them and resume live from highWater so later events survive.
          skipUnknownEventTypes: true,
        })
        .pipe(
          Stream.map((stored) => ({
            kind: "event" as const,
            sequence: stored.sequence,
            event: projectDomainEventForWire(stored.event),
          })),
          Stream.runCollect,
          Effect.map((items) => Array.from(items)),
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed while replaying orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );

    const completionMarker =
      input.requestCompletionMarker === true
        ? Stream.make({ kind: "synchronized" as const })
        : Stream.empty;

    const snapshotThenLive = Effect.fn("ws.orchestrationV2.threadSnapshotThenLive")(function* () {
      const useBoundedSnapshot = shouldUseBoundedThreadSnapshot(input);
      const snapshot = yield* (
        useBoundedSnapshot
          ? threadManagement.getThreadSnapshotWindow(input.threadId, {
              rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
              deferWork: input.acceptDeferredWork === true,
              userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
            })
          : threadManagement.getThreadSnapshot(input.threadId)
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to load orchestration V2 thread ${input.threadId}`,
              cause,
            }),
        ),
      );
      const { snapshotSequence } = snapshot;
      const snapshotItem = useBoundedSnapshot
        ? buildBoundedThreadStreamSnapshot({
            ...snapshot,
            compactTurnItems: input.acceptCompactTurnItems === true,
            dedupeBodies,
            compactIds: input.acceptCompactIds === true,
          })
        : (() => {
            const projection = projectThreadProjectionForWire(snapshot.projection);
            return {
              kind: "snapshot" as const,
              snapshotSequence,
              projection: dedupeBodies ? dedupeSnapshotBodies(projection) : projection,
            };
          })();
      return rpcInitialItems([snapshotItem]).pipe(
        Stream.concat(completionMarker),
        Stream.concat(eventStreamFrom(snapshotSequence)),
        withLiveDedupe,
      );
    });

    // Subscribe before reading persisted events to retain concurrent publishes; clients dedupe overlap by sequence.
    if (input.afterSequence !== undefined) {
      const highWater = yield* applicationEvents.latestAgentSequence(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to prepare orchestration V2 thread ${input.threadId} replay`,
              cause,
            }),
        ),
      );
      if (input.afterSequence > highWater) {
        return yield* snapshotThenLive();
      }
      const stats = yield* applicationEvents
        .getAgentReplayStats({
          threadId: input.threadId,
          afterSequence: input.afterSequence,
          throughSequence: highWater,
          maxEvents: THREAD_RESUME_MAX_REPLAY_EVENTS,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed to measure orchestration V2 thread ${input.threadId} replay`,
                cause,
              }),
          ),
        );
      // Bound stored and projected payload bytes separately; neither bounds process memory.
      if (
        stats.eventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
        !isThreadReplayRawPayloadSafe(stats.rawPayloadBytes)
      ) {
        return yield* snapshotThenLive();
      }
      if (stats.hasCreateEvent) {
        const shell = yield* threadManagement.getThreadShell(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed to locate recreated orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );
        // Retained creation events may describe deleted threads; replace replay only if a snapshot exists.
        if (shell !== null) return yield* snapshotThenLive();
      }
      const replay = coalesceLiveUpdatedEvents(
        yield* loadReplayThrough(input.afterSequence, highWater),
      );
      const plan = decideThreadResume({
        afterSequence: input.afterSequence,
        highWater,
        replayEventCount: replay.length,
        replayEncodedBytes: threadReplayEncodedBytes(replay),
      });
      if (plan.mode === "snapshot") {
        return yield* snapshotThenLive();
      }
      return rpcInitialItems(replay).pipe(
        Stream.concat(completionMarker),
        Stream.concat(eventStreamFrom(highWater)),
        withLiveDedupe,
      );
    }

    return yield* snapshotThenLive();
  },
);

export const subscribeOrchestrationV2Shell = Effect.fn("ws.orchestrationV2.subscribeShell")(
  function* (input: {
    readonly afterSequence?: number;
    readonly requestCompletionMarker?: boolean;
    readonly omitIdleSubagents?: boolean;
    readonly omitOlderSettled?: boolean;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projectService = yield* ProjectService.ProjectService;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    let subagentThreadIds = new Set<string>();
    const filterSubagentTranscript = (stored: ApplicationStoredEvent) =>
      shouldPublishShellApplicationEvent(stored, subagentThreadIds);

    const enrichmentChanges = yield* projectEnrichment.subscribeChanges;
    const loadProjectMetadataSnapshot = Effect.fn("ws.orchestrationV2.loadProjectMetadataSnapshot")(
      function* (snapshotSequence: number) {
        const enriched = yield* enrichProjectShells(yield* projects.listShells());
        return {
          snapshot: {
            schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
            snapshotSequence,
            projects: enriched.projects,
            threads: [],
            archivedThreads: [],
          } as OrchestrationV2ShellSnapshot,
          resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
        };
      },
    );
    const loadSnapshot = Effect.fn("ws.orchestrationV2.loadShellSnapshot")(function* () {
      const forSubscriber = yield* loadSubscriberShellSnapshot({
        sql,
        listShellIndex: threadManagement.listActiveShellIndex(),
        readThreads: (threadIds) =>
          threadManagement.readShellSnapshot({
            location: "active",
            ...(threadIds === undefined ? {} : { threadIds }),
          }),
        listProjects: projects.listShells(),
        latestSequence: applicationEvents.latestApplicationSequence,
        options: {
          omitIdleSubagents: input.omitIdleSubagents === true,
          omitOlderSettled: input.omitOlderSettled === true,
        },
      });
      subagentThreadIds = forSubscriber.subagentThreadIds;
      const enriched = yield* enrichProjectShells(forSubscriber.snapshot.projects);
      return {
        snapshot: {
          ...forSubscriber.snapshot,
          projects: enriched.projects,
        } as OrchestrationV2ShellSnapshot,
        resolvedRepositoryIdentityRoots: enriched.resolvedRepositoryIdentityRoots,
      };
    });
    const projectItem = Effect.fn("ws.orchestrationV2.projectShellItem")(function* (
      stored: Extract<ShellApplicationEvent, { readonly aggregateKind: "project" }>,
    ) {
      if (stored.type === "project.deleted") {
        return {
          kind: "project.removed" as const,
          sequence: stored.sequence,
          projectId: stored.aggregateId,
        };
      }
      const project = yield* projectService.getShell(stored.aggregateId);
      return Option.match(project, {
        onNone: () => ({
          kind: "project.removed" as const,
          sequence: stored.sequence,
          projectId: stored.aggregateId,
        }),
        onSome: (value) => ({
          kind: "project.updated" as const,
          sequence: stored.sequence,
          project: value,
        }),
      });
    });

    const projectShellItems = Effect.fn("ws.orchestrationV2.projectShellItems")(function* (
      events: ReadonlyArray<ShellApplicationEvent>,
    ) {
      return yield* Effect.forEach(
        coalesceShellApplicationEvents(events),
        (stored) =>
          Effect.gen(function* () {
            if ("aggregateKind" in stored) {
              return yield* projectItem(stored);
            }
            const shell = yield* threadManagement.getThreadShell(stored.event.threadId);
            return shellStreamItemFromThreadShell({ stored, shell });
          }),
        { concurrency: 8 },
      );
    });

    const toShellStream = <E, R>(stream: Stream.Stream<ShellApplicationEvent, E, R>) =>
      stream.pipe(
        Stream.groupedWithin(512, Duration.millis(50)),
        Stream.mapEffect((events) => projectShellItems(Array.from(events))),
        Stream.flatMap(Stream.fromIterable),
        skipUnchangedThreadShells,
      );

    const liveFrom = (afterSequence: number) =>
      bufferShellLiveStream(
        toShellStream(
          applicationEvents.streamProjectedApplicationEvents({
            afterSequence,
            project: toShellApplicationEvent,
            filter: filterSubagentTranscript,
          }),
        ),
      );

    const enrichmentRefreshes = Stream.fromSubscription(enrichmentChanges).pipe(
      Stream.filter((change) => change.repositoryIdentityResolved),
      Stream.groupedWithin(64, Duration.millis(25)),
      Stream.mapEffect((changes) =>
        Effect.gen(function* () {
          const identities = new Map(
            Array.from(changes, (change) => [
              change.workspaceRoot,
              change.enrichment.repositoryIdentity,
            ]),
          );
          const snapshotSequence = yield* applicationEvents.latestApplicationSequence;
          const changedProjects = (yield* projects.listShells()).flatMap((project) =>
            identities.has(project.workspaceRoot)
              ? [{ ...project, repositoryIdentity: identities.get(project.workspaceRoot) ?? null }]
              : [],
          );
          return shellStreamItemFromEnrichmentRefresh({
            snapshot: {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence,
              projects: changedProjects,
              threads: [],
              archivedThreads: [],
            } as OrchestrationV2ShellSnapshot,
            changes: Array.from(changes),
          });
        }),
      ),
    );

    // Subscribe before loading for racing enrichments; initial refresh covers pre-subscription completions and cold HTTP snapshots.
    const completionMarker =
      input.requestCompletionMarker === true
        ? Stream.make({ kind: "synchronized" as const })
        : Stream.empty;
    const initialSnapshotItems = (loaded: {
      readonly snapshot: OrchestrationV2ShellSnapshot;
      readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
    }) =>
      rpcInitialItems(
        shellStreamItemsFromInitialSnapshot({
          snapshot: loaded.snapshot,
          resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
        }),
      );
    const initialEnrichmentItems = (loaded: {
      readonly snapshot: OrchestrationV2ShellSnapshot;
      readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
    }) =>
      rpcInitialItems(
        shellStreamItemsFromResumeSnapshot({
          snapshot: loaded.snapshot,
          resolvedRepositoryIdentityRoots: loaded.resolvedRepositoryIdentityRoots,
        }),
      );
    // Drain initial frames before merging enrichment with live events so marked refreshes cannot precede the initial frame.
    const completionThenLive = (afterSequence: number) =>
      Stream.concat(completionMarker, liveFrom(afterSequence));

    const stream = yield* Effect.gen(function* () {
      if (input.afterSequence === undefined) {
        const loaded = yield* loadSnapshot();
        return composeShellStreamWithEnrichment({
          initial: initialSnapshotItems(loaded),
          tail: completionThenLive(loaded.snapshot.snapshotSequence),
          enrichment: enrichmentRefreshes,
        });
      }

      const highWater = yield* applicationEvents.latestApplicationSequence;
      if (!(yield* canReplayPersistedRange(input.afterSequence, highWater, SHELL_RESUME_MAX_GAP))) {
        const loaded = yield* loadSnapshot();
        return composeShellStreamWithEnrichment({
          initial: initialSnapshotItems(loaded),
          tail: completionThenLive(loaded.snapshot.snapshotSequence),
          enrichment: enrichmentRefreshes,
        });
      }

      subagentThreadIds = new Set(yield* threadManagement.listActiveSubagentThreadIds());

      const loaded = yield* loadProjectMetadataSnapshot(highWater);
      const replay = toShellStream(
        applicationEvents
          .readApplicationEvents({
            afterSequence: input.afterSequence,
            throughSequence: highWater,
            // A row a newer build wrote (e.g. after a downgrade) must not fail
            // every shell resubscribe. The live tail below resumes from
            // highWater, so a dropped row never hides later events.
            skipUnknownEventTypes: true,
          })
          .pipe(Stream.filter(filterSubagentTranscript)),
      );
      return composeShellStreamWithEnrichment({
        initial: initialEnrichmentItems(loaded),
        tail: Stream.concat(Stream.concat(replay, completionMarker), liveFrom(highWater)),
        enrichment: enrichmentRefreshes,
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: "Failed to prepare the application shell stream",
            cause,
          }),
      ),
    );

    return stream.pipe(
      dedupeShellEnrichment,
      Stream.mapError(
        (cause) =>
          new OrchestrationV2GetShellSnapshotError({
            message: "Failed while streaming the application shell",
            cause,
          }),
      ),
    );
  },
);

export const layerWsRpc = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  clientAnalyticsProps: Readonly<Record<string, unknown>>,
  serverBrowser: ServerBrowser.ServerBrowser["Service"],
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const sql = yield* SqlClient.SqlClient;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const intakeContext = yield* Effect.context<
        | ThreadManagementService.ThreadManagementService
        | ThreadLaunchService.ThreadLaunchService
        | FileSystem.FileSystem
        | ServerConfig.ServerConfig
        | ServerSettings.ServerSettingsService
        | DocumentText.DocumentText
      >();
      const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
      const projectStore = yield* ProjectStore.ProjectStoreV2;
      const projectService = yield* ProjectService.ProjectService;
      const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const scratchThreadPromotion = yield* ScratchThreadPromotion.ScratchThreadPromotion;
      const eventLoopMonitor = yield* EventLoopMonitor.EventLoopMonitor;
      const threadSearch = yield* ThreadSearch.ThreadSearch;

      const providerSessionsV2 = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const mcpAppRequests = yield* McpAppRequests.McpAppRequests;
      const analytics = yield* AnalyticsService.AnalyticsService;
      const originProps = clientAnalyticsProps;
      const recordClientCommandAnalytics = (command: OrchestrationV2Command) => {
        const usage = commandFeatureUsage(command);
        return Effect.all(
          [
            command.type === "message.dispatch"
              ? analytics.record("client.turn.requested", originProps)
              : Effect.void,
            usage === undefined
              ? Effect.void
              : analytics.record("feature.used", {
                  ...usage,
                  ...(originProps.surface === undefined ? {} : { surface: originProps.surface }),
                }),
          ],
          { discard: true },
        ).pipe(Effect.ignore);
      };
      const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
      const commandOutputHub = yield* CommandOutputHub.CommandOutputHub;
      const providerSessionManager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
      const secretRequests = yield* SecretRequests.SecretRequests;
      const guestShares = yield* GuestShareService.GuestShareService;
      const pullRequests = yield* PullRequestService.PullRequestService;
      const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
      const pullRequestSync = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      const deviceService = yield* DeviceService.DeviceService;
      const deviceHostContext =
        yield* Effect.context<Effect.Services<ReturnType<typeof remoteSshDeviceHosts>>>();
      const orchestrationEngine = yield* Orchestrator.OrchestratorV2;
      const crypto = yield* Crypto.Crypto;
      // RPC client ids are only unique within one socket; terminals share viewers across sockets.
      const terminalViewerPrefix = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const terminalViewerId = (metadata: { readonly client: { readonly id: number } }) =>
        `${terminalViewerPrefix}:${metadata.client.id}`;
      const serverCommandId = (tag: string) =>
        crypto.randomUUIDv4().pipe(
          Effect.orDie,
          Effect.map((id) => CommandId.make(`server:${tag}:${id}`)),
        );
      const resolvePullRequestSyncKey = (reference: PullRequestRef) =>
        reference.host !== undefined && reference.repository.includes("/")
          ? Effect.succeed(pullRequestSyncKey(reference))
          : projectService.getShell(reference.projectId).pipe(
              Effect.map((project) =>
                pullRequestSyncKey(reference, Option.getOrUndefined(project)?.repositoryIdentity),
              ),
              Effect.orElseSucceed(() => null),
            );
      const usage = yield* UsageService.UsageService;
      const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
      const worktreeSetupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const repositoryIdentityResolver =
        yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
      const agentSessionScanner = yield* AgentSessionScanner.AgentSessionScanner;
      const agentSessionImporter = yield* AgentSessionImporter.AgentSessionImporter;
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;
      const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const previewManager = yield* PreviewManager.PreviewManager;
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const providerLatestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
      const acpRegistryCatalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      const acpRegistryRuntimeCoordinator =
        yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const providerAuth = yield* ProviderAuthService.ProviderAuthService;
      const providerInstallation = yield* makeProviderInstallation();
      const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const storageCleanup = yield* StorageCleanup.StorageCleanup;
      const databaseStorage = yield* DatabaseStorage.DatabaseStorage;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const peerLinks = yield* PeerLinks.PeerLinks;
      const peerLinkRequests = yield* PeerLinkRequests.PeerLinkRequests;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());
      yield* Effect.addFinalizer(() =>
        Ref.get(rpcClientIds).pipe(
          Effect.flatMap((clientIds) =>
            Effect.forEach(
              clientIds,
              (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
              {
                discard: true,
              },
            ),
          ),
          Effect.ignore,
        ),
      );
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const otlpEndpointCheck = yield* OtlpEndpointCheck.OtlpEndpointCheck;
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const sourceControlSignIn = yield* SourceControlSignIn.SourceControlSignIn;
      const withPullRequestViewer = pullRequests.withRoutingCredential;
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const triage = yield* TriageService.TriageService;
      const hostResources = yield* HostResources.HostResources;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
      const relayClient = yield* RelayClient.RelayClient;
      // Webhook URLs start agents; expose them only to operate-scoped sessions while keeping tasks readable.
      const withVisibleWebhookUrls = (result: ScheduledTaskListResult): ScheduledTaskListResult =>
        currentSession.scopes.includes(AuthOrchestrationOperateScope)
          ? result
          : {
              tasks: result.tasks.map(({ webhook: _webhook, ...task }) => task),
            };
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(rpcAuthorizationError(requiredScope));

      const acpRegistryProject = Effect.fn("ws.acpRegistry.project")(function* (
        projectId: ProjectId,
      ) {
        const project = yield* projectService.getById(projectId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "project_not_found",
                message: `Project ${projectId} is unavailable.`,
                cause,
              }),
          ),
        );
        return yield* Effect.fromOption(
          project,
          () =>
            new AcpRegistryOperationError({
              reason: "project_not_found",
              message: `Project ${projectId} was not found.`,
            }),
        );
      });

      const acpSessionManager = Effect.fn("ws.acpRegistry.sessionManager")(function* (
        instanceId: ProviderInstanceId,
      ) {
        const instance = yield* providerInstances.getInstance(instanceId);
        if (instance === undefined) {
          return yield* new AcpRegistryOperationError({
            reason: "instance_not_found",
            message: `Provider instance ${instanceId} was not found.`,
          });
        }
        if (instance.acpSessionManagement === undefined) {
          return yield* new AcpRegistryOperationError({
            reason: "session_list_unsupported",
            message: `Provider instance ${instanceId} does not expose ACP session management.`,
          });
        }
        return { instance, manager: instance.acpSessionManagement };
      });

      const importedAcpThreadId = (input: {
        readonly driver: ProviderDriverKind;
        readonly instanceId: ProviderInstanceId;
        readonly sessionId: string;
      }) =>
        IdAllocator.deriveThreadFromProviderThread({
          driver: input.driver,
          providerInstanceId: input.instanceId,
          nativeThreadId: input.sessionId,
        });

      const listAcpRegistrySessions = Effect.fn("ws.acpRegistry.listSessions")(function* (
        input: AcpRegistryListSessionsInput,
      ) {
        const project = yield* acpRegistryProject(input.projectId);
        const { instance, manager } = yield* acpSessionManager(input.instanceId);
        const listed = yield* manager.listSessions({
          cwd: project.workspaceRoot,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
        const sessions = yield* Effect.forEach(
          listed.sessions,
          (session) => {
            const threadId = importedAcpThreadId({
              driver: instance.driverKind,
              instanceId: input.instanceId,
              sessionId: session.sessionId,
            });
            return threadManagement.getThreadShell(threadId).pipe(
              Effect.map((thread) => ({
                ...session,
                importedThreadId: thread === null ? null : threadId,
              })),
              Effect.mapError(
                (cause) =>
                  new AcpRegistryOperationError({
                    reason: "session_import_failed",
                    message: "Could not inspect existing imported ACP sessions.",
                    cause,
                  }),
              ),
            );
          },
          { concurrency: 16 },
        );
        return { ...listed, sessions };
      });

      const importAcpRegistrySession = Effect.fn("ws.acpRegistry.importSession")(function* (
        input: AcpRegistryImportSessionInput,
      ) {
        return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
          Effect.gen(function* () {
            yield* acpRegistryProject(input.projectId);
            const { instance } = yield* acpSessionManager(input.instanceId);
            const providerSnapshot = yield* instance.snapshot.getSnapshot;
            if (
              providerSnapshot.nativeSessions?.canLoad !== true &&
              providerSnapshot.nativeSessions?.canResume !== true
            ) {
              return yield* new AcpRegistryOperationError({
                reason: "session_resume_unsupported",
                message: "The ACP agent cannot load or resume native sessions.",
              });
            }
            const threadId = importedAcpThreadId({
              driver: instance.driverKind,
              instanceId: input.instanceId,
              sessionId: input.sessionId,
            });
            const existing = yield* threadManagement.getThreadShell(threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryOperationError({
                    reason: "session_import_failed",
                    message: "Could not inspect the imported ACP session mapping.",
                    cause,
                  }),
              ),
            );
            if (existing !== null) return { threadId, imported: false } as const;

            const provider = (yield* providerRegistry.getProviders).find(
              (candidate) => candidate.instanceId === input.instanceId,
            );
            const model =
              provider?.models.find((candidate) => candidate.isDefault)?.slug ??
              provider?.models[0]?.slug ??
              "default";
            const commandId = CommandId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
            const launched = yield* Effect.result(
              startup.enqueueCommand(
                threadLaunch.launch({
                  commandId,
                  threadId,
                  projectId: input.projectId,
                  title: input.title ?? "Imported ACP session",
                  modelSelection: { instanceId: input.instanceId, model },
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  workspaceStrategy: { type: "root" },
                  importedNativeThread: {
                    ref: {
                      driver: instance.driverKind,
                      nativeId: input.sessionId,
                      strength: "strong",
                    },
                    metadata: {
                      itemIdentityVersion: 2,
                      ...(input.title === undefined ? {} : { title: input.title }),
                      ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
                    },
                  },
                  createdBy: "user",
                  creationSource: "web",
                }),
              ),
            );
            if (Result.isFailure(launched)) {
              const racedImport = yield* threadManagement.getThreadShell(threadId).pipe(
                Effect.mapError(
                  (cause) =>
                    new AcpRegistryOperationError({
                      reason: "session_import_failed",
                      message: "Could not inspect the imported ACP session after launch failed.",
                      cause,
                    }),
                ),
              );
              if (racedImport !== null) return { threadId, imported: false } as const;
              return yield* new AcpRegistryOperationError({
                reason: "session_import_failed",
                message: "Could not create a T3 thread for the ACP session.",
                cause: launched.failure,
              });
            }
            return { threadId, imported: true } as const;
          }),
        );
      });

      const deleteAcpRegistrySession = Effect.fn("ws.acpRegistry.deleteSession")(function* (
        input: AcpRegistryDeleteSessionInput,
      ) {
        return yield* acpRegistryRuntimeCoordinator.withSessionMutation(
          Effect.gen(function* () {
            const project = yield* acpRegistryProject(input.projectId);
            const { instance, manager } = yield* acpSessionManager(input.instanceId);
            const snapshot = yield* instance.snapshot.getSnapshot;
            if (snapshot.nativeSessions?.canDelete !== true) {
              return yield* new AcpRegistryOperationError({
                reason: "session_delete_unsupported",
                message: "The ACP agent does not advertise session deletion.",
              });
            }
            const threadId = importedAcpThreadId({
              driver: instance.driverKind,
              instanceId: input.instanceId,
              sessionId: input.sessionId,
            });
            const importedThread = yield* threadManagement.getThreadShell(threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpRegistryOperationError({
                    reason: "session_delete_failed",
                    message: "Could not inspect the imported ACP session mapping.",
                    cause,
                  }),
              ),
            );
            if (importedThread !== null) {
              return yield* new AcpRegistryOperationError({
                reason: "session_delete_failed",
                message: "Delete the imported T3 thread before deleting its native ACP session.",
              });
            }
            yield* manager.deleteSession({
              cwd: project.workspaceRoot,
              sessionId: input.sessionId,
            });
            return { deleted: true } as const;
          }),
        );
      });

      const listAcpRegistryProviders = Effect.fn("ws.acpRegistry.listProviders")(function* (
        input: AcpRegistryListProvidersInput,
      ) {
        const project = yield* acpRegistryProject(input.projectId);
        const { instance, manager } = yield* acpSessionManager(input.instanceId);
        const snapshot = yield* instance.snapshot.getSnapshot;
        if (snapshot.configurableProviders !== true) {
          return yield* new AcpRegistryOperationError({
            reason: "providers_unsupported",
            message: "The ACP agent does not advertise provider configuration.",
          });
        }
        return yield* manager.listProviders(project.workspaceRoot);
      });

      const setAcpRegistryProvider = Effect.fn("ws.acpRegistry.setProvider")(function* (
        input: AcpRegistrySetProviderInput,
      ) {
        const project = yield* acpRegistryProject(input.projectId);
        const { manager } = yield* acpSessionManager(input.instanceId);
        if (input.headers !== undefined && Object.keys(input.headers).length > 32) {
          return yield* new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message: "ACP provider configuration accepts at most 32 headers.",
          });
        }
        const listed = yield* manager.listProviders(project.workspaceRoot);
        const provider = listed.providers.find(
          (candidate) => candidate.providerId === input.providerId,
        );
        if (provider === undefined || !provider.supported.includes(input.apiType)) {
          return yield* new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message: `Provider ${input.providerId} does not support ${input.apiType}.`,
          });
        }
        yield* providerSessionManager.closeInstance(input.instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "provider_configuration_failed",
                message: "Could not stop live sessions before updating the ACP provider.",
                cause,
              }),
          ),
        );
        yield* manager.setProvider({
          cwd: project.workspaceRoot,
          providerId: input.providerId,
          apiType: input.apiType,
          baseUrl: input.baseUrl,
          ...(input.headers === undefined ? {} : { headers: input.headers }),
        });
        yield* providerRegistry.refreshInstance(input.instanceId);
        return { configured: true } as const;
      });

      const disableAcpRegistryProvider = Effect.fn("ws.acpRegistry.disableProvider")(function* (
        input: AcpRegistryDisableProviderInput,
      ) {
        const project = yield* acpRegistryProject(input.projectId);
        const { manager } = yield* acpSessionManager(input.instanceId);
        const listed = yield* manager.listProviders(project.workspaceRoot);
        const provider = listed.providers.find(
          (candidate) => candidate.providerId === input.providerId,
        );
        if (provider === undefined || provider.required) {
          return yield* new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message:
              provider === undefined
                ? `Provider ${input.providerId} was not advertised by the ACP agent.`
                : `Provider ${input.providerId} is required and cannot be disabled.`,
          });
        }
        yield* providerSessionManager.closeInstance(input.instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryOperationError({
                reason: "provider_configuration_failed",
                message: "Could not stop live sessions before disabling the ACP provider.",
                cause,
              }),
          ),
        );
        yield* manager.disableProvider({
          cwd: project.workspaceRoot,
          providerId: input.providerId,
        });
        yield* providerRegistry.refreshInstance(input.instanceId);
        return { disabled: true } as const;
      });
      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks(),
          clientSessions: serverAuth.listClientSessions(currentSessionId),
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthAccessStreamError({
                message: error.message,
              }),
          ),
        );

      const loadServerConfig = Effect.fn("ws.loadServerConfig")(function* (options: {
        readonly usageLimitsCommand: boolean;
        readonly workspaceSnapshotsOnDemand: boolean;
        readonly creditBalances?: boolean;
      }) {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const currentProviders = yield* providerRegistry.getProviders;
        const commandProviders = options.usageLimitsCommand
          ? withUsageLimitsCommands(currentProviders, yield* usageLimitSources.current)
          : currentProviders;
        const providers = options.workspaceSnapshotsOnDemand
          ? withoutWorkspaceSnapshots(commandProviders)
          : commandProviders;
        const settings = ServerSettings.redactServerSettingsForClient(
          yield* serverSettings.getSettings,
        );
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();
        const scratchWorkspaceRoot = yield* managedFolders.scratchRoot;
        const lastEventLoopStall = yield* eventLoopMonitor.latestNoticeableStall;
        const editorConfig = yield* resolveEditorConfig(
          yield* resolveAvailableEditorsForConfig(externalLauncher.resolveAvailableEditors()),
          resolveFileManagerRevealKindForConfig(externalLauncher.resolveFileManagerRevealKind()),
        );

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          ...editorConfig,
          remoteOpenTargets: yield* resolveAvailableEditorsForConfig(
            remoteOpenTargets.resolveTargets(),
          ),
          directEndpoints: yield* resolveAvailableEditorsForConfig(directEndpoints.resolve()),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined
              ? {
                  otlpTracesUrl: config.otlpTracesUrl,
                  otlpTracesSource: config.otlpTracesSource,
                  otlpTracesVariable: config.otlpTracesVariable,
                }
              : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? {
                  otlpMetricsUrl: config.otlpMetricsUrl,
                  otlpMetricsSource: config.otlpMetricsSource,
                  otlpMetricsVariable: config.otlpMetricsVariable,
                }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
            ...(config.otlpLogsUrl !== undefined
              ? {
                  otlpLogsUrl: config.otlpLogsUrl,
                  otlpLogsSource: config.otlpLogsSource,
                  otlpLogsVariable: config.otlpLogsVariable,
                }
              : {}),
            otlpLogsEnabled: config.otlpLogsUrl !== undefined,
          },
          settings: options.creditBalances === true ? settings : legacyCreditSettings(settings),
          shellResumeCompletionMarker: true,
          shellThreadFamilies: true,
          shellOlderSettled: true,
          threadResumeCompletionMarker: true,
          threadSnapshotPagination: true,
          threadFind: true,
          threadFindProgressive: true,
          secretProviderSettings: true,
          secretReferences: true,
          ...Option.match(scratchWorkspaceRoot, {
            onNone: () => ({}),
            onSome: (root) => ({ scratchWorkspaceRoot: root }),
          }),
          newProjectsRoot: managedFolders.namedProjectsRoot,
          ...(lastEventLoopStall === undefined ? {} : { lastEventLoopStall }),
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      const getOrchestrationV2ArchivedShellSnapshot = Effect.gen(function* () {
        const { threads, projects, snapshotSequence } = yield* loadShellSnapshotParts({
          sql,
          readThreads: threadManagement.readShellSnapshot({ location: "archive" }),
          listProjects: projectStore.listShells(),
          latestSequence: applicationEvents.latestApplicationSequence,
        });
        return {
          schemaVersion: threads.schemaVersion,
          snapshotSequence,
          projects,
          threads: threads.archivedThreads,
        } as const;
      }).pipe(
        Effect.flatMap((snapshot) =>
          enrichProjectShells(snapshot.projects).pipe(
            Effect.map(({ projects }) => ({ ...snapshot, projects })),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetShellSnapshotError({
              message: "Failed to load archived thread snapshot",
              cause,
            }),
        ),
      );

      // Rows the shell can omit, read with the same snapshot sequence the shell uses.
      const readOmittableShellRows = Effect.fn("ws.orchestrationV2.readOmittableShellRows")(
        function* (
          options: { readonly familyOf: ThreadId } | { readonly worktreePath: string },
          message: string,
        ) {
          const { threads, snapshotSequence } = yield* loadShellSnapshotParts({
            sql,
            readThreads: threadManagement.readShellSnapshot({ location: "active", ...options }),
            listProjects: Effect.succeed([]),
            latestSequence: applicationEvents.latestApplicationSequence,
          }).pipe(
            Effect.mapError(
              (cause) => new OrchestrationV2GetShellSnapshotError({ message, cause }),
            ),
          );
          return { snapshotSequence, threads: threads.threads };
        },
      );

      const mutateProject = Effect.fn("ws.projects.mutate")(function* (mutation: ProjectMutation) {
        const result = yield* projectMutationOperation(projectService, mutation);
        if (mutation.type === "project.delete")
          yield* projectCloneTracker.discard(mutation.projectId);
        return result;
      });

      const handlers = ServerWsRpcGroup.of({
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
          Effect.annotateCurrentSpan({
            "orchestration_v2.command_id": command.commandId,
            "orchestration_v2.command_type": command.type,
            "orchestration_v2.thread_id":
              command.type === "thread.fork" || command.type === "thread.merge_back"
                ? command.targetThreadId
                : command.type === "delegated_task.request" ||
                    command.type === "delegated_task.wake-policy" ||
                    command.type === "delegated_task.completion-delivery.acknowledge" ||
                    command.type === "delegated_task.completion-delivery.dispose" ||
                    command.type === "thread.created.record"
                  ? command.parentThreadId
                  : command.threadId,
            ...(command.type === "thread.fork" || command.type === "thread.merge_back"
              ? { "orchestration_v2.source_thread_id": command.sourceThreadId }
              : {}),
          }).pipe(
            Effect.andThen(
              startup
                .enqueueCommand(
                  (command.type === "prepared-run.retry"
                    ? threadLaunch.retryPreparation(command)
                    : ThreadMessageIntake.dispatchCommand(
                        ThreadManagementService.withCreationProvenance(command, {
                          createdBy: "user",
                          creationSource:
                            "creationSource" in command ? command.creationSource : "web",
                        }),
                      )
                  ).pipe(Effect.provide(intakeContext)),
                )
                .pipe(
                  Effect.tap((result) =>
                    result.replayed ? Effect.void : recordClientCommandAnalytics(command),
                  ),
                  Effect.map((result) => ({ sequence: result.sequence })),
                  Effect.mapError((cause) => {
                    const detail = userFacingDispatchErrorMessage(cause);
                    return new OrchestrationV2DispatchCommandError({
                      commandId: command.commandId,
                      commandType: command.type,
                      message: detail ?? "Failed to dispatch orchestration V2 command",
                      ...(detail === undefined ? {} : { detail }),
                      cause,
                    });
                  }),
                ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: (input) => threadManagement.stopWorkflow(input),
        [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: (input) =>
          threadManagement.forceStopThread(input),
        [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: (input) =>
          readWorkflowScript({ scriptPath: input.scriptPath }),
        [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: (input) =>
          threadManagement.getTurnItem(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetThreadProjectionError({
                  threadId: input.threadId,
                  message: "Failed to load turn item",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: (input) =>
          checkpointDiffQuery.getTurnDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetTurnDiffError({
                  message: "Failed to load turn diff",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: (input) =>
          checkpointDiffQuery.getFullThreadDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetFullThreadDiffError({
                  message: "Failed to load full thread diff",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.searchThread]: (input) =>
          threadManagement
            .searchThread(input)
            .pipe(Effect.mapError((cause) => new OrchestrationV2SearchThreadError({ cause }))),
        [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: (input) =>
          threadManagement
            .searchThreadStream(input)
            .pipe(Stream.mapError((cause) => new OrchestrationV2SearchThreadError({ cause }))),
        [ORCHESTRATION_V2_WS_METHODS.searchThreads]: (input) =>
          ThreadSearch.searchThreadsWithOlderSettledRows({
            request: input,
            search: threadSearch.search,
            searchOlderSettled: threadSearch.searchOlderSettled,
            sql,
            readThreads: (threadIds) =>
              threadManagement.readShellSnapshot({ location: "active", threadIds }),
            latestSequence: applicationEvents.latestApplicationSequence,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationSearchThreadsError({
                  message: "Failed to search threads",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          getOrchestrationV2ArchivedShellSnapshot,
        [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: (input) =>
          readOmittableShellRows({ familyOf: input.threadId }, "Failed to load the thread family"),
        [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]: (input) =>
          loadOlderSettledThreadsPage({
            sql,
            listThreads: threadManagement.listOlderSettledThreads(input),
            readThreads: (threadIds) =>
              threadManagement.readShellSnapshot({ location: "active", threadIds }),
            latestSequence: applicationEvents.latestApplicationSequence,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetShellSnapshotError({
                  message: "Failed to load older settled threads",
                  cause,
                }),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]: (input) =>
          readOmittableShellRows(
            { worktreePath: input.worktreePath },
            "Failed to load the worktree's threads",
          ).pipe(Effect.map(({ threads }) => ({ threadIds: threads.map((thread) => thread.id) }))),
        [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(
              // Bound compatibility snapshots so pre-pagination clients cannot materialize unlimited transcripts.
              threadManagement
                .getThreadSnapshotWindow(input.threadId, {
                  rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
                })
                .pipe(
                  Effect.map(
                    (snapshot) =>
                      buildBoundedThreadProjection({
                        projection: projectThreadProjectionForWire(snapshot.projection),
                        snapshotSequence: snapshot.snapshotSequence,
                      }).projection,
                  ),
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationV2GetThreadProjectionError({
                        threadId: input.threadId,
                        message: `Failed to load orchestration V2 thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input) =>
          Effect.annotateCurrentSpan({
            "orchestration_v2.command_id": input.commandId,
            "orchestration_v2.project_id": input.projectId,
          }).pipe(
            Effect.andThen(
              startup
                .enqueueCommand(
                  ThreadMessageIntake.launchThread({
                    commandId: input.commandId,
                    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                    ...(input.reuseExistingThread === undefined
                      ? {}
                      : { reuseExistingThread: input.reuseExistingThread }),
                    projectId: input.projectId,
                    title: input.title,
                    ...(input.generateTitle === undefined
                      ? {}
                      : { generateTitle: input.generateTitle }),
                    modelSelection: input.modelSelection,
                    runtimeMode: input.runtimeMode,
                    interactionMode: input.interactionMode,
                    workspaceStrategy: input.workspaceStrategy,
                    ...(input.initialMessage === undefined
                      ? {}
                      : {
                          initialMessage: {
                            ...(input.initialMessage.messageId === undefined
                              ? {}
                              : { messageId: input.initialMessage.messageId }),
                            text: input.initialMessage.text,
                            attachments: input.initialMessage.attachments,
                            ...(input.initialMessage.context === undefined
                              ? {}
                              : { context: input.initialMessage.context }),
                          },
                        }),
                    createdBy: "user",
                    creationSource: input.creationSource ?? "web",
                  }).pipe(Effect.provide(intakeContext)),
                )
                .pipe(
                  // A resumed launch is a retry of one already counted.
                  Effect.tap((result) =>
                    result.resumed
                      ? Effect.void
                      : analytics
                          .record("client.thread.started", {
                            ...originProps,
                            workspaceStrategy: input.workspaceStrategy.type,
                          })
                          .pipe(
                            Effect.andThen(
                              input.initialMessage === undefined
                                ? Effect.void
                                : analytics.record("client.turn.requested", originProps),
                            ),
                            Effect.ignore,
                          ),
                  ),
                  Effect.map((result) => ({
                    ...result,
                    projection: projectThreadProjectionForWire(result.projection),
                  })),
                  Effect.catchTags({
                    AttachmentClaimError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: cause.message,
                        cause,
                      }),
                    ThreadLaunchError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: "Failed to launch thread",
                        cause,
                      }),
                    ServerRuntimeStartupError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: "Failed to launch thread",
                        cause,
                      }),
                    ThreadManagementProviderInstanceDisabledError: (cause) =>
                      new OrchestrationV2ThreadLaunchError({
                        commandId: input.commandId,
                        projectId: input.projectId,
                        message: cause.message,
                        cause,
                      }),
                  }),
                ),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input) =>
          Stream.unwrap(subscribeOrchestrationV2Shell(input)),
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input) =>
          Stream.unwrap(
            Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
              Effect.andThen(subscribeOrchestrationV2Thread(input)),
            ),
          ),
        [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: (input) =>
          Stream.unwrap(
            Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
              Effect.as(commandOutputHub.subscribe(input)),
            ),
          ),
        [WS_METHODS.scheduledTasksSubscribe]: (_input) =>
          scheduledTasks.subscribeList().pipe(Stream.map(withVisibleWebhookUrls)),
        [WS_METHODS.scheduledTasksUpsert]: (input) => scheduledTasks.upsert(input),
        [WS_METHODS.scheduledTasksSetEnabled]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.setEnabled(input)),
          ),
        [WS_METHODS.scheduledTasksDelete]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.delete(input)),
          ),
        [WS_METHODS.scheduledTasksRunNow]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.runNow(input)),
          ),
        [WS_METHODS.scheduledTasksRotateWebhookToken]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.rotateWebhookToken(input)),
          ),
        [WS_METHODS.guestShareCreate]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(guestShares.create(input)),
          ),
        [WS_METHODS.secretsAnswerRequest]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(secretRequests.answer(input)),
          ),
        [WS_METHODS.scheduledTasksListWebhookDeliveries]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.listWebhookDeliveries(input)),
          ),
        [WS_METHODS.scheduledTasksGetWebhookDelivery]: (input) =>
          Effect.annotateCurrentSpan({ "scheduled_task.id": input.id }).pipe(
            Effect.andThen(scheduledTasks.getWebhookDelivery(input)),
          ),
        [WS_METHODS.serverProbe]: (_input) => Effect.succeed({}),
        [WS_METHODS.serverGetConfig]: (_input) =>
          loadServerConfig({ usageLimitsCommand: false, workspaceSnapshotsOnDemand: false }),
        [WS_METHODS.serverSearchAcpRegistry]: (input) =>
          acpRegistryCatalog
            .search(input)
            .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError)),
        [WS_METHODS.serverPrepareAcpRegistryAgent]: (input) =>
          Effect.annotateCurrentSpan({ "acp_registry.agent_id": input.agentId }).pipe(
            Effect.andThen(
              acpRegistryCatalog
                .prepare(input)
                .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError)),
            ),
          ),
        [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: (input) =>
          Effect.annotateCurrentSpan({ "acp_registry.agent_id": input.agentId }).pipe(
            Effect.andThen(
              acpRegistryCatalog
                .uninstallManagedBinary(input)
                .pipe(Effect.mapError(AcpRegistrySupport.toAcpRegistryOperationError)),
            ),
          ),
        [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: (input) =>
          Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId }).pipe(
            Effect.andThen(
              acpRegistryRuntimeCoordinator
                .acceptUrlAuthentication(input)
                .pipe(Effect.map((accepted) => ({ accepted }))),
            ),
          ),
        [WS_METHODS.serverListAcpRegistrySessions]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(listAcpRegistrySessions(input))),
        [WS_METHODS.serverImportAcpRegistrySession]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(importAcpRegistrySession(input))),
        [WS_METHODS.serverDeleteAcpRegistrySession]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(deleteAcpRegistrySession(input))),
        [WS_METHODS.serverListAcpRegistryProviders]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(listAcpRegistryProviders(input))),
        [WS_METHODS.serverSetAcpRegistryProvider]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(setAcpRegistryProvider(input))),
        [WS_METHODS.serverDisableAcpRegistryProvider]: (input) =>
          Effect.annotateCurrentSpan({
            "provider.instance_id": input.instanceId,
            "project.id": input.projectId,
          }).pipe(Effect.andThen(disableAcpRegistryProvider(input))),
        [WS_METHODS.serverLogoutAcpRegistry]: (input) =>
          Effect.annotateCurrentSpan({ "provider.instance_id": input.instanceId }).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const { instance, manager } = yield* acpSessionManager(input.instanceId);
                const snapshot = yield* instance.snapshot.getSnapshot;
                if (snapshot.auth.canLogout !== true) {
                  return yield* new AcpRegistryOperationError({
                    reason: "logout_unsupported",
                    message: "The ACP agent does not advertise logout.",
                  });
                }
                if (instance.auth) {
                  yield* providerAuth.logout(input).pipe(
                    Effect.mapError(
                      (cause) =>
                        new AcpRegistryOperationError({
                          reason: "logout_failed",
                          message: "Could not sign out of the ACP agent.",
                          cause,
                        }),
                    ),
                  );
                } else {
                  yield* providerSessionManager.closeInstance(input.instanceId).pipe(
                    Effect.mapError(
                      (cause) =>
                        new AcpRegistryOperationError({
                          reason: "logout_failed",
                          message: "Could not stop live sessions before ACP logout.",
                          cause,
                        }),
                    ),
                  );
                  yield* manager.logout(config.cwd);
                }
                yield* providerRegistry.refreshInstance(input.instanceId);
                return { loggedOut: true } as const;
              }),
            ),
          ),
        [WS_METHODS.serverRefreshProviders]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (input) {
            if (input.refreshModels) {
              yield* modelManifest.forceRefresh;
              const instances = yield* providerInstances.listInstances;
              yield* Effect.forEach(
                instances.filter(
                  (instance) =>
                    input.instanceId === undefined || input.instanceId === instance.instanceId,
                ),
                (instance) =>
                  Effect.gen(function* () {
                    yield* instance.invalidateCaches ?? Effect.void;
                    const maintenance = yield* instance.snapshot.resolveMaintenance({
                      fresh:
                        input.instanceId !== undefined &&
                        input.cwd !== undefined &&
                        input.fresh !== true,
                    });
                    yield* Effect.forEach(
                      latestProviderVersionCacheKeys(maintenance),
                      providerLatestVersions.invalidate,
                      { discard: true },
                    );
                  }),
                { concurrency: "unbounded", discard: true },
              );
            }
            // Await refresh; RPC scope closure would interrupt a fork before the hub answered.
            if (input.instanceId === undefined) {
              yield* usageLimitSources.refresh;
            }
            let providers = yield* input.cwd !== undefined && input.instanceId !== undefined
              ? providerRegistry.refreshWorkspaceSnapshot({
                  instanceId: input.instanceId,
                  cwd: input.cwd,
                  fresh: input.fresh === true,
                })
              : input.reloadSecrets === true
                ? providerRegistry.reloadSecretsAndRefresh(input.instanceId)
                : input.instanceId !== undefined
                  ? providerRegistry.refreshInstance(input.instanceId)
                  : providerRegistry.refresh();
            if (input.refreshModels) {
              const instances = yield* providerInstances.listInstances;
              for (const instance of instances) {
                if (
                  !instance.refreshModels ||
                  (input.instanceId !== undefined && input.instanceId !== instance.instanceId) ||
                  !providers.some(
                    (provider) =>
                      provider.instanceId === instance.instanceId &&
                      provider.enabled &&
                      provider.installed,
                  )
                )
                  continue;
                yield* instance.refreshModels().pipe(
                  Effect.mapError(
                    (error) =>
                      new ProviderSetupError({
                        instanceId: instance.instanceId,
                        operation: "refresh-models",
                        detail: error.detail,
                      }),
                  ),
                );
                providers = yield* providerRegistry.refreshInstance(instance.instanceId);
              }
            }
            if (input.workspaceSnapshotsOnDemand !== true) return { providers };
            const commandProviders =
              input.usageLimitsCommand === true
                ? withUsageLimitsCommands(providers, yield* usageLimitSources.current)
                : providers;
            const { instanceId, cwd } = input;
            if (instanceId === undefined || cwd === undefined) {
              return { providers: withoutWorkspaceSnapshots(commandProviders) };
            }
            return {
              providers: commandProviders
                .filter((provider) => provider.instanceId === instanceId)
                .map((provider) => ({
                  ...provider,
                  // Callers read only the cwd snapshot; the config stream carries the rest.
                  models: [],
                  slashCommands: [],
                  skills: [],
                  workspaceSnapshots: (provider.workspaceSnapshots ?? []).filter(
                    (snapshot) => snapshot.cwd === cwd,
                  ),
                })),
            };
          }),
        [WS_METHODS.mcpAppsCallTool]: (input) => mcpAppRequests.callTool(input),
        [WS_METHODS.mcpAppsToolInfo]: (input) => mcpAppRequests.toolInfo(input),
        [WS_METHODS.mcpAppsUpdateModelContext]: (input) => mcpAppRequests.updateModelContext(input),
        [WS_METHODS.mcpAppsReadResource]: (input) => mcpAppRequests.readResource(input),
        [WS_METHODS.providerUploadFeedback]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(
            function* (input) {
              const projection = yield* threadManagement.getThreadRecords(input.threadId, [
                "providerThreads",
              ]);
              const providerThread =
                projection.providerThreads.find(
                  (candidate) => candidate.id === projection.thread.activeProviderThreadId,
                ) ?? projection.providerThreads.at(-1);
              const providerSessionId = providerThread?.providerSessionId ?? null;
              if (providerThread === undefined || providerSessionId === null) {
                return yield* new ProviderUploadFeedbackError({
                  threadId: input.threadId,
                  cause: "No provider session has run in this thread yet.",
                });
              }
              const runtime = Option.getOrNull(yield* providerSessionsV2.get(providerSessionId));
              if (runtime === null) {
                return yield* new ProviderUploadFeedbackError({
                  threadId: input.threadId,
                  cause: "The provider session is no longer running. Send a message first.",
                });
              }
              if (runtime.uploadFeedback === undefined) {
                return yield* new ProviderUploadFeedbackError({
                  threadId: input.threadId,
                  cause: `Provider '${runtime.driver}' does not support feedback uploads.`,
                });
              }
              return yield* runtime.uploadFeedback({
                providerThread,
                ...(input.reason === undefined ? {} : { reason: input.reason }),
              });
            },
            (effect, input) =>
              effect.pipe(
                Effect.mapError((cause) =>
                  isProviderUploadFeedbackError(cause)
                    ? cause
                    : new ProviderUploadFeedbackError({
                        threadId: input.threadId,
                        cause,
                      }),
                ),
              ),
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          providerMaintenanceRunner.updateProvider(input),
        [WS_METHODS.providerConsumeResetCredit]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (input) {
            if ("sourceId" in input) return yield* usageLimitSources.consumeResetCredit(input);
            const instance = yield* providerInstances.getInstance(input.instanceId);
            if (instance === undefined || !instance.enabled) {
              return yield* new ProviderSetupError({
                instanceId: input.instanceId,
                operation: "consume-reset-credit",
                detail: instance ? "This provider is disabled." : "Provider instance not found.",
              });
            }
            if (instance.consumeResetCredit === undefined) {
              return yield* new ProviderSetupError({
                instanceId: input.instanceId,
                operation: "consume-reset-credit",
                detail: "This provider does not bank reset credits.",
              });
            }
            const outcome = yield* instance.consumeResetCredit().pipe(
              Effect.mapError(
                (error) =>
                  new ProviderSetupError({
                    instanceId: input.instanceId,
                    operation: "consume-reset-credit",
                    detail: error.detail,
                    cause: error,
                  }),
              ),
            );
            return { outcome };
          }),
        [WS_METHODS.providerAuthStart]: (input) => providerAuth.start(input, currentSessionId),
        [WS_METHODS.providerAuthRespond]: (input) =>
          Effect.annotateCurrentSpan({ instanceId: input.instanceId }).pipe(
            Effect.andThen(providerAuth.respond(input, currentSessionId)),
          ),
        [WS_METHODS.providerAuthComplete]: (input) =>
          providerAuth.complete(input, currentSessionId),
        [WS_METHODS.chatGptReconnectProfile]: (input) => providerAuth.reconnectProfile(input),
        [WS_METHODS.chatGptImportProfile]: (input) => providerAuth.importProfile(input),
        [WS_METHODS.chatGptHandoffSubscribe]: (input) =>
          subscribeChatGptHandoff(input, currentSessionId),
        [WS_METHODS.providerAuthCancel]: (input) => providerAuth.cancel(input, currentSessionId),
        [WS_METHODS.providerAuthLogout]: (input) => providerAuth.logout(input),
        [WS_METHODS.providerAuthSubscribe]: (input) =>
          providerAuth.subscribe(input, currentSessionId),
        [WS_METHODS.providerInstallStart]: (input) => providerInstallation.start(input),
        [WS_METHODS.providerInstallCancel]: (input) => providerInstallation.cancel(input),
        [WS_METHODS.providerInstallSubscribe]: (input) => providerInstallation.subscribe(input),
        [WS_METHODS.providerInstallRemove]: (input) => providerInstallation.remove(input),
        [WS_METHODS.serverUpdateServer]: (input) => serverSelfUpdate.update(input),
        [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
          ServerSelfUpdate.updateProgressStream(serverSelfUpdate, input),
        [WS_METHODS.serverCommitDesktopUpdate]: (input) =>
          serverSelfUpdate.commitDesktopUpdate(input.requestId),
        [WS_METHODS.serverUpsertKeybinding]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (rule) {
            const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
        [WS_METHODS.serverRemoveKeybinding]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (rule) {
            const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
        [WS_METHODS.serverRunStorageCleanup]: () => storageCleanup.runNow,
        [WS_METHODS.serverGetStorageCleanupReport]: () => storageCleanup.reports,
        [WS_METHODS.serverGetDatabaseStorage]: () => databaseStorage.status,
        [WS_METHODS.peerLinksList]: (_input) =>
          peerLinks.list.pipe(Effect.map((links) => ({ links }))),
        [WS_METHODS.peerLinksLink]: (input) => peerLinks.link(input),
        [WS_METHODS.peerLinksUnlink]: ({ environmentId }) =>
          peerLinks.unlink(environmentId).pipe(Effect.map((removed) => ({ removed }))),
        [WS_METHODS.peerLinksAnswerRequest]: (input) =>
          Effect.annotateCurrentSpan({ "orchestration_v2.thread_id": input.threadId }).pipe(
            Effect.andThen(peerLinkRequests.answer(input)),
          ),
        [WS_METHODS.serverUpdateSettings]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* ({ patch, providerInstanceMutation }) {
            const deviceHosts = patch.deviceHosts
              ? yield* remoteSshDeviceHosts(patch.deviceHosts).pipe(
                  Effect.provide(deviceHostContext),
                )
              : undefined;
            const nextPatch = { ...patch, ...(deviceHosts ? { deviceHosts } : {}) };
            const settings = yield* providerInstanceMutation === undefined
              ? serverSettings.updateSettings(nextPatch)
              : serverSettings.updateProviderInstance(providerInstanceMutation, nextPatch);
            return ServerSettings.redactServerSettingsForClient(settings);
          }),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) => sourceControlDiscovery.discover,
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          TraceDiagnostics.readTraceDiagnostics({
            traceFilePath: config.serverTracePath,
            maxFiles: config.traceMaxFiles,
          }),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) => processDiagnostics.read,
        [WS_METHODS.serverGetHostResources]: (_input) => hostResources.read,
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          processResourceMonitor.readHistory(input),
        [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
          resourceTelemetry.readHistory(input),
        [WS_METHODS.serverGetUsageSummary]: (input) => usage.readSummary(input),
        [WS_METHODS.serverRefreshUsageRates]: (_input) => usage.refreshRates,
        [WS_METHODS.serverRetryResourceTelemetry]: (_input) => resourceTelemetry.retry,
        [WS_METHODS.serverCheckOtlpEndpoint]: (input) => otlpEndpointCheck.check(input),
        [WS_METHODS.serverPrepareTriage]: (input) => triage.prepare(input),
        [WS_METHODS.serverSignalProcess]: (input) => processDiagnostics.signal(input),
        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
          Ref.update(rpcClientIds, (clientIds) => {
            const next = new Set(clientIds);
            next.add(RpcClientId.make(metadata.client.id));
            return next;
          }).pipe(
            Effect.andThen(
              backgroundPolicy.reportClientActivity(
                currentSessionId,
                RpcClientId.make(metadata.client.id),
                input,
              ),
            ),
          ),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) => relayClient.resolve,
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>((queue) =>
            relayClient
              .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
              .pipe(
                Effect.flatMap((status) =>
                  Queue.offer(queue, {
                    type: "complete",
                    status,
                  }),
                ),
                Effect.catchTags({
                  RelayClientInstallError: (error) =>
                    Queue.fail(
                      queue,
                      new RelayClientInstallFailedError({
                        reason: error.reason,
                        message: error.message,
                      }),
                    ),
                }),
                Effect.andThen(Queue.end(queue)),
                Effect.forkScoped,
              ),
          ),
        [WS_METHODS.pullRequestsList]: (input) => pullRequests.list(input),
        [WS_METHODS.pullRequestsListStats]: (input) => pullRequests.listStats(input),
        [WS_METHODS.pullRequestsFilterOptions]: (input) => pullRequests.filterOptions(input),
        [WS_METHODS.pullRequestsRoutingIdentity]: (input) => pullRequests.routingIdentity(input),
        [WS_METHODS.pullRequestsRouting]: (input) => pullRequests.routing(input),
        [WS_METHODS.pullRequestsSummary]: (input) =>
          withPullRequestViewer(input, pullRequests.summary(input)),
        [WS_METHODS.pullRequestsStack]: (input) =>
          withPullRequestViewer(input, pullRequests.stack(input)),
        [WS_METHODS.pullRequestsLinkedThreads]: (input) =>
          resolvePullRequestSyncKey(input).pipe(
            Effect.flatMap((key) =>
              key === null
                ? Effect.succeed({ threads: [] })
                : listLinkedPullRequestThreads(key).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql),
                  ),
            ),
          ),
        [WS_METHODS.pullRequestsDetail]: (input) =>
          withPullRequestViewer(input, pullRequests.detail(input)),
        [WS_METHODS.pullRequestsPreview]: (input) =>
          withPullRequestViewer(input, pullRequests.preview(input)),
        [WS_METHODS.pullRequestsChecks]: (input) =>
          withPullRequestViewer(input, pullRequests.checks(input)),
        [WS_METHODS.pullRequestsActivity]: (input) =>
          withPullRequestViewer(input, pullRequests.activity(input)),
        [WS_METHODS.pullRequestsReviewGuide]: (input) =>
          withPullRequestViewer(input, reviewGuides.get(input)),
        [WS_METHODS.pullRequestsGenerateReviewGuide]: (input) =>
          withPullRequestViewer(input, reviewGuides.generate(input)),
        [WS_METHODS.pullRequestsThreadComments]: (input) =>
          withPullRequestViewer(input, pullRequests.threadComments(input)),
        [WS_METHODS.pullRequestsDiffFileContents]: (input) =>
          withPullRequestViewer(input, pullRequests.diffFileContents(input)),
        [WS_METHODS.pullRequestsFilesViewed]: (input) =>
          withPullRequestViewer(input, pullRequests.filesViewed(input)),
        [WS_METHODS.pullRequestsChangeBreakdown]: (input) =>
          withPullRequestViewer(input, pullRequests.changeBreakdown(input)),
        [WS_METHODS.pullRequestsSetFilesViewed]: (input) =>
          withPullRequestViewer(input, pullRequests.setFilesViewed(input)),
        [WS_METHODS.pullRequestsRunAction]: (input) =>
          withPullRequestViewer(input, pullRequests.runAction(input)).pipe(
            Effect.tap(() =>
              resolvePullRequestSyncKey(input).pipe(
                Effect.flatMap((key) =>
                  key === null ? Effect.void : pullRequestSync.requestSync(key),
                ),
              ),
            ),
          ),
        [WS_METHODS.pullRequestsUpdate]: (input) =>
          withPullRequestViewer(input, pullRequests.update(input)),
        [WS_METHODS.pullRequestsComment]: (input) =>
          withPullRequestViewer(input, pullRequests.comment(input)),
        [WS_METHODS.pullRequestsUpdateComment]: (input) =>
          withPullRequestViewer(input, pullRequests.updateComment(input)),
        [WS_METHODS.pullRequestsSubmitReview]: (input) =>
          withPullRequestViewer(input, pullRequests.submitReview(input)),
        [WS_METHODS.pullRequestsReplyToThread]: (input) =>
          withPullRequestViewer(input, pullRequests.replyToThread(input)),
        [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
          withPullRequestViewer(input, pullRequests.setThreadResolution(input)),
        [WS_METHODS.pullRequestsSetReaction]: (input) =>
          withPullRequestViewer(input, pullRequests.setReaction(input)),
        [WS_METHODS.pullRequestsReportState]: (input) => pullRequests.reportState(input),
        [WS_METHODS.pullRequestsInvalidate]: (input) =>
          pullRequests
            .invalidate(input, { notifyReaders: true })
            .pipe(
              Effect.andThen(
                input.reference === undefined || input.filesViewedOnly === true
                  ? Effect.void
                  : resolvePullRequestSyncKey(input.reference).pipe(
                      Effect.flatMap((key) =>
                        key === null ? Effect.void : pullRequestSync.requestSync(key),
                      ),
                    ),
              ),
            ),
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => pullRequests.subscribeRefreshes,
        [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
          withPullRequestViewer(input, pullRequests.reviewerCandidates(input)),
        [WS_METHODS.pullRequestsRequestReviewers]: (input) =>
          withPullRequestViewer(input, pullRequests.requestReviewers(input)),
        [WS_METHODS.pullRequestsLabelCandidates]: (input) =>
          withPullRequestViewer(input, pullRequests.labelCandidates(input)),
        [WS_METHODS.pullRequestsSetLabels]: (input) =>
          withPullRequestViewer(input, pullRequests.setLabels(input)),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          sourceControlRepositories.lookupRepository(input),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          sourceControlRepositories.cloneRepository(input),
        [WS_METHODS.sourceControlSignInStart]: (input) => sourceControlSignIn.start(input),
        [WS_METHODS.sourceControlSignInWait]: (input) => sourceControlSignIn.wait(input),
        [WS_METHODS.sourceControlSignInCancel]: (input) => sourceControlSignIn.cancel(input),
        [WS_METHODS.sourceControlAppAccess]: (input) => sourceControlSignIn.access(input),
        [WS_METHODS.projectCloneStart]: (input) =>
          projectCloneTracker.start(input, {
            createProject: (project) =>
              projectService
                .create({
                  commandId: CommandId.make(`project-clone-create:${project.projectId}`),
                  projectId: project.projectId,
                  title: project.title,
                  workspaceRoot: project.workspaceRoot,
                  createWorkspaceRootIfMissing: true,
                })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationDispatchCommandError({
                        message: "Failed to create clone project.",
                        cause,
                      }),
                  ),
                ),
            onCloned: (project) =>
              repositoryIdentityResolver.resolve(project.workspaceRoot, { refresh: true }).pipe(
                Effect.andThen(
                  projectService.update({
                    commandId: CommandId.make(`project-clone-done:${project.projectId}`),
                    projectId: project.projectId,
                  }),
                ),
                Effect.andThen(refreshGitStatus(project.workspaceRoot)),
                // The folder was empty when the project was created, so the cached
                // enrichment says "no repository" and clients cannot group it yet.
                Effect.andThen(projectEnrichment.invalidate([project.workspaceRoot])),
                Effect.andThen(projectEnrichment.request(project.workspaceRoot)),
                Effect.ignoreCause({ log: true }),
              ),
          }),
        [WS_METHODS.projectsEnsureScratch]: () =>
          managedFolders.ensureScratchProject.pipe(
            Effect.mapError(
              (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
            ),
          ),
        [WS_METHODS.projectsCreateNew]: (input) =>
          managedFolders
            .createNamedProject(input)
            .pipe(
              Effect.mapError(
                (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
              ),
            ),
        [WS_METHODS.projectsCreateFromThread]: (input) =>
          scratchThreadPromotion
            .promote(input)
            .pipe(
              Effect.mapError(
                (cause) => new OrchestrationDispatchCommandError({ message: cause.message, cause }),
              ),
            ),
        [WS_METHODS.projectCloneCancel]: (input) =>
          projectCloneTracker.cancel(input.projectId).pipe(Effect.map((applied) => ({ applied }))),
        [WS_METHODS.projectCloneRetry]: (input) =>
          projectCloneTracker.retry(input.projectId).pipe(Effect.map((applied) => ({ applied }))),
        [WS_METHODS.subscribeProjectClones]: () => projectCloneTracker.stream,
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          sourceControlRepositories.publishRepository(input).pipe(
            Effect.tap(() => repositoryIdentityResolver.resolve(input.cwd, { refresh: true })),
            Effect.tap(() => refreshGitStatus(input.cwd)),
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          workspaceEntries.search(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSearchEntriesError({
                  cwd: input.cwd,
                  queryLength: input.query.length,
                  limit: input.limit,
                  ...projectEntriesFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsSearchContents]: (input) =>
          workspaceEntries.searchContents(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSearchContentsError({
                  cwd: input.cwd,
                  queryLength: input.query.length,
                  limit: input.limit,
                  ...projectEntriesFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          workspaceEntries.list(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectListEntriesError({
                  ...input,
                  ...projectEntriesFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsListIgnoredFiles]: (input) =>
          workspaceEntries.listIgnoredFiles(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectListEntriesError({
                  ...input,
                  ...projectEntriesFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          workspaceFileSystem.readFile(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectReadFileError({
                  ...input,
                  ...projectFileFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          workspaceFileSystem.writeFile(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectWriteFileError({
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                  ...projectFileFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.projectsMutate]: (mutation) =>
          startup.enqueueCommand(mutateProject(mutation)).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectMutationError({
                  commandId: mutation.commandId,
                  message:
                    cause._tag === "ProjectNotEmptyError"
                      ? cause.message
                      : "Failed to mutate project.",
                  cause,
                }),
            ),
          ),
        [WS_METHODS.shellOpenInEditor]: (input) => externalLauncher.launchEditor(input),
        [WS_METHODS.filesystemGetMetadata]: (input) => workspaceFileSystem.getMetadata(input),
        [WS_METHODS.filesystemBrowse]: (input) =>
          workspaceEntries.browse(input).pipe(
            Effect.mapError(
              (cause) =>
                new FilesystemBrowseError({
                  ...input,
                  ...filesystemBrowseFailureContext(cause),
                  cause,
                }),
            ),
          ),
        [WS_METHODS.attachmentsCreateUploadUrl]: (input) => issueAttachmentUploadUrl(input),
        [WS_METHODS.attachmentsDelete]: (input) => deletePendingAttachment(input.attachmentId),
        [WS_METHODS.agentSessionsScan]: () => agentSessionScanner.scan,
        [WS_METHODS.agentSessionsImport]: (input) =>
          agentSessionImporter.importRecentAgentThreads(input),
        [WS_METHODS.assetsCreateUrl]:
          /* Request instrumentation already owns the span; keep this helper in that context. */
          Effect.fnUntraced(function* (input) {
            const path = yield* Path.Path;
            if (
              input.resource._tag === "attachment" ||
              input.resource._tag === "native-app-icon" ||
              input.resource._tag === "tool-output-image" ||
              input.resource._tag === SOURCE_CONTROL_MEDIA_ASSET ||
              // A network path is served only from the thread's project, looked up below.
              (input.resource._tag === "media-file" &&
                path.isAbsolute(input.resource.path) &&
                !isNetworkPath(input.resource.path))
            ) {
              return yield* issueAssetUrl({ resource: input.resource });
            }
            if (input.resource._tag === "draft-workspace-file") {
              return yield* issueAssetUrl({
                resource: input.resource,
                workspaceRoot: input.resource.cwd,
              });
            }
            if (input.resource._tag === "project-favicon") {
              const project = yield* projectStore
                .findActiveByWorkspaceRoot(input.resource.cwd)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              // Clone projects precede their files; clients retry asset URLs after clone completion.
              const clone = yield* projectCloneTracker.get(project.value.projectId);
              return yield* issueAssetUrl({
                resource: input.resource,
                ...(project.value.faviconPath
                  ? { projectFaviconPath: project.value.faviconPath }
                  : {}),
                ...(clone !== null && clone.destinationPath === project.value.workspaceRoot
                  ? { projectCheckout: clone.phase === "done" ? "cloned" : "pending" }
                  : {}),
              });
            }
            const thread = yield* threadManagement
              .getThreadRecords(input.resource.threadId, [])
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AssetWorkspaceContextResolutionError({
                      resource: input.resource,
                      cause,
                    }),
                ),
              );
            const project = yield* projectService.getById(thread.thread.projectId).pipe(
              Effect.mapError(
                (cause) =>
                  new AssetWorkspaceContextResolutionError({
                    resource: input.resource,
                    cause,
                  }),
              ),
            );
            if (Option.isNone(project)) {
              return yield* new AssetWorkspaceContextNotFoundError({
                resource: input.resource,
              });
            }
            return yield* issueAssetUrl({
              resource: input.resource,
              workspaceRoot: thread.thread.worktreePath ?? project.value.workspaceRoot,
            });
          }),
        [WS_METHODS.assetsPersistChatAttachments]: (input) =>
          persistChatAttachments(input).pipe(Effect.map((attachments) => ({ attachments }))),
        [WS_METHODS.subscribeVcsStatus]: (input) => vcsStatusBroadcaster.streamStatus(input),
        [WS_METHODS.subscribeWorktreeSetup]: (input) => worktreeSetupTracker.stream(input.threadId),
        [WS_METHODS.worktreeSetupCancel]: (input) =>
          worktreeSetupTracker
            .cancel(input.threadId)
            .pipe(Effect.map((cancelled) => ({ cancelled }))),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          vcsStatusBroadcaster.refreshStatus(input.cwd, { localOnly: input.localOnly ?? false }),
        [WS_METHODS.vcsPull]: (input) =>
          gitWorkflow.pullCurrentBranch(input.cwd).pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) => Effect.failCause(cause),
              onSuccess: (result) =>
                refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
            }),
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
            gitWorkflow
              .runStackedAction(input, {
                actionId: input.actionId,
                progressReporter: {
                  publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                },
              })
              .pipe(
                Effect.matchCauseEffect({
                  onFailure: (cause) => Queue.failCause(queue, cause),
                  onSuccess: (result) =>
                    (input.threadId === undefined
                      ? Effect.void
                      : linkCreatedPullRequest({
                          threadId: input.threadId,
                          result,
                          commandId: serverCommandId("pr-created-link"),
                        }).pipe(
                          Effect.provideService(Orchestrator.OrchestratorV2, orchestrationEngine),
                          Effect.provideService(ProjectService.ProjectService, projectService),
                        )
                    ).pipe(
                      Effect.andThen(
                        refreshPushedPullRequests(input, result).pipe(
                          Effect.provideService(Orchestrator.OrchestratorV2, orchestrationEngine),
                          Effect.provideService(ProjectStore.ProjectStoreV2, projectStore),
                          Effect.provideService(
                            PullRequestService.PullRequestService,
                            pullRequests,
                          ),
                        ),
                      ),
                      Effect.andThen(refreshGitStatus(input.cwd)),
                      Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                    ),
                }),
              ),
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) => gitWorkflow.resolvePullRequest(input),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          gitWorkflow
            .preparePullRequestThread(input)
            .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsListRefs]: (input) => gitWorkflow.listRefs(input),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsCreateRef]: (input) =>
          gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.vcsInit]: (input) =>
          vcsProvisioning.initRepository(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        [WS_METHODS.reviewGetBranchCommits]: (input) => review.getBranchCommits(input),
        [WS_METHODS.reviewGetDiffPreview]: (input) => review.getDiffPreview(input),
        [WS_METHODS.reviewGetDiffFileContents]: (input) => review.getDiffFileContents(input),
        [WS_METHODS.terminalOpen]: (input) => terminalManager.open(input),
        [WS_METHODS.terminalAttach]: (input, metadata) =>
          terminalManager.attachOutputStream(input, terminalViewerId(metadata)),
        [WS_METHODS.terminalWrite]: (input) => terminalManager.write(input),
        [WS_METHODS.terminalResize]: (input, metadata) =>
          terminalManager.resize(input, terminalViewerId(metadata)),
        [WS_METHODS.terminalClear]: (input) => terminalManager.clear(input),
        [WS_METHODS.terminalClose]: (input) => terminalManager.close(input),
        [WS_METHODS.terminalObserve]: (input) =>
          terminalOutputStream(
            (listener, registerCleanup) =>
              terminalManager.observeStream(input, listener, registerCleanup),
            (listener, registerCleanup) =>
              terminalManager.resyncStream(input, listener, registerCleanup),
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          Stream.callback<TerminalMetadataStreamEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
        [WS_METHODS.previewOpen]: (input) => previewManager.open(input),
        [WS_METHODS.previewResize]: (input) => previewManager.resize(input),
        [WS_METHODS.previewAdjust]: (input) => previewManager.adjust(input),
        [WS_METHODS.previewClose]: (input) => previewManager.close(input),
        [WS_METHODS.previewList]: (input) => previewManager.list(input),
        [WS_METHODS.previewClearProfile]: (input) => serverBrowser.clearProfile(input.profileId),
        [WS_METHODS.previewReportProfiles]: (input) => serverBrowser.reportProfiles(input),
        [WS_METHODS.previewReportStatus]: (input) => previewManager.reportStatus(input),
        [WS_METHODS.subscribePreviewEvents]: (_input) => previewManager.events,
        [WS_METHODS.deviceConfigure]: (input) => deviceService.configure(input),
        [WS_METHODS.deviceTestHost]: (input) => deviceService.testHost(input),
        [WS_METHODS.deviceEasAccount]: (input) => deviceService.easAccount(input),
        [WS_METHODS.deviceSimlockIdentity]: (input) => deviceService.simlockIdentity(input),
        [WS_METHODS.deviceList]: (input) =>
          input.inspectOnly && !input.updateTool
            ? deviceService.inspect
            : authorizeEffect(
                requiredScopeForDeviceList(input),
                input.updateTool
                  ? deviceService.updateTool(input.updateTool)
                  : input.retryHostId
                    ? deviceService.retryHost(input.retryHostId)
                    : deviceService.list,
              ),
        [WS_METHODS.deviceOpen]: (input) =>
          threadWorkspaceRoot(input.threadId).pipe(
            Effect.flatMap((workspaceRoot) => deviceService.open(input, { workspaceRoot })),
          ),
        [WS_METHODS.deviceClose]: (input) => deviceService.close(input),
        [WS_METHODS.deviceShutdown]: (input) => deviceService.shutdown(input),
        [WS_METHODS.deviceDetail]: (input) => deviceService.detail(input),
        [WS_METHODS.deviceAction]: (input) => deviceService.action(input),
        [WS_METHODS.subscribeDeviceState]: (_input) => DeviceService.stateStream(deviceService),
        [WS_METHODS.previewStopLocalServer]: (input) => portDiscovery.stopServer(input),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (input) =>
          Stream.callback<DiscoveredLocalServerList>((queue) =>
            Effect.gen(function* () {
              const configuredUrls = input.configuredUrls ?? [];
              yield* portDiscovery.retain;
              const initial = yield* portDiscovery.scan(configuredUrls);
              const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
              yield* Queue.offer(queue, {
                servers: initial,
                scannedAt: initialScannedAt,
                configuredUrlProbing: true,
              });
              yield* portDiscovery.subscribe(
                { configuredUrls, initialSnapshot: initial },
                (servers) =>
                  Effect.gen(function* () {
                    const scannedAt = DateTime.formatIso(yield* DateTime.now);
                    yield* Queue.offer(queue, {
                      servers,
                      scannedAt,
                      configuredUrlProbing: true,
                    });
                  }),
              );
            }),
          ),
        [WS_METHODS.subscribeServerConfig]: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const usageLimitsCommand = input.usageLimitsCommand === true;
              const workspaceSnapshotsOnDemand = input.workspaceSnapshotsOnDemand === true;
              // Buffer changes through discovery and the initial snapshot's RPC ACK wait.
              const keybindingsChanges = yield* keybindings.subscribeChanges;
              const settingsChanges = yield* serverSettings.subscribeChanges;
              const config = yield* loadServerConfig({
                usageLimitsCommand,
                workspaceSnapshotsOnDemand,
                creditBalances: input.creditBalances === true,
              });
              const keybindingsUpdates = keybindingsChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = Stream.zipLatestWith(
                // Seed the changes-only stream so early source refreshes pair with current providers.
                Stream.concat(
                  Stream.fromEffect(providerRegistry.getProviders),
                  providerRegistry.streamChanges,
                ),
                usageLimitSources.streamChanges.pipe(
                  Stream.changesWith(
                    usageLimitsCommand ? sameUsageLimitCommandCoverage : () => true,
                  ),
                ),
                (providers, sources) => {
                  const commandProviders = usageLimitsCommand
                    ? withUsageLimitsCommands(providers, sources)
                    : providers;
                  // Stripped before the de-dupe below, so snapshot-only changes send nothing.
                  return workspaceSnapshotsOnDemand
                    ? withoutWorkspaceSnapshots(commandProviders)
                    : commandProviders;
                },
              ).pipe(
                // Compare initial paired values with the snapshot; blindly dropping them loses changes between snapshot and subscription.
                (updates) => Stream.concat(rpcInitialItems([config.providers]), updates),
                Stream.changesWith(
                  (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
                ),
                Stream.drop(1),
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              // Gate capability-specific events; older clients reject them and lose their config subscription.
              const environmentThemeUpdates =
                input.environmentThemes === true
                  ? environmentTheme.streamChanges.pipe(
                      Stream.map((themes) => ({
                        version: 1 as const,
                        type: "environmentThemesUpdated" as const,
                        payload: { themes },
                      })),
                    )
                  : Stream.empty;
              const usageLimitSourceUpdates =
                input.usageLimitSources === true
                  ? usageLimitSources.streamChanges.pipe(
                      Stream.map((sources) => ({
                        version: 1 as const,
                        type: "usageLimitSourcesUpdated" as const,
                        payload: {
                          sources:
                            input.creditBalances === true ? sources : legacyCreditSources(sources),
                        },
                      })),
                    )
                  : Stream.empty;
              const settingsUpdates = settingsChanges.pipe(
                Stream.map((settings) => {
                  const redacted = ServerSettings.redactServerSettingsForClient(settings);
                  return input.creditBalances === true ? redacted : legacyCreditSettings(redacted);
                }),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(
                  providerStatuses,
                  Stream.merge(
                    settingsUpdates,
                    Stream.merge(environmentThemeUpdates, usageLimitSourceUpdates),
                  ),
                ),
              );

              return Stream.concat(
                rpcInitialItems([{ version: 1 as const, type: "snapshot" as const, config }]),
                withLateEditorConfig(config, liveUpdates, externalLauncher),
              );
            }),
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const liveBuffer = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
              yield* Effect.forkScoped(
                lifecycleEvents.stream.pipe(
                  Stream.runForEach((event) => Queue.offer(liveBuffer, event)),
                ),
                { startImmediately: true },
              );
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = Stream.fromQueue(liveBuffer).pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(rpcInitialItems(snapshotEvents), liveEvents);
            }),
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                rpcInitialItems([
                  {
                    version: 1 as const,
                    revision: 1,
                    type: "snapshot" as const,
                    payload: initialSnapshot,
                  },
                ]),
                liveEvents,
              );
            }),
          ),
        [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
          Stream.unwrap(
            Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
              Stream.concat(Stream.make(latest), changes),
            ),
          ),
      });
      const splitHandlers: Pick<typeof handlers, SplitWsRpc["_tag"]> = handlers;
      const otherHandlers: Pick<typeof handlers, Exclude<ServerWsRpc, SplitWsRpc>["_tag"]> =
        handlers;
      return Context.merge(
        yield* SplitWsRpcGroup.toHandlers(splitHandlers),
        yield* OtherWsRpcGroup.toHandlers(otherHandlers),
      );
    }),
  );

// Default socket-level Defect frames end every pending client request.
export const WS_RPC_SERVER_OPTIONS = {
  disableTracing: true,
  disableFatalDefects: true,
} as const;

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const serverBrowser = yield* ServerBrowser.ServerBrowser;
    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;
    const peerLinks = yield* PeerLinks.PeerLinks;
    const peerLinkRequests = yield* PeerLinkRequests.PeerLinkRequests;
    const sql = yield* SqlClient.SqlClient;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const requestUrl = HttpServerRequest.toURL(request);
        if (Option.isNone(requestUrl) || !hasCompatibleOrchestrationProtocol(requestUrl.value)) {
          return HttpServerResponse.jsonUnsafe(
            {
              code: "orchestration_protocol_incompatible",
              message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            },
            { status: 426 },
          );
        }
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const analytics = yield* AnalyticsService.AnalyticsService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request, "rpc").pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const clientAnalyticsProps = readClientAnalyticsProps(request);
        yield* analytics.recordOwners(readClientOwners(request), "client");
        const rpcWebSocketHttpEffect = yield* Effect.gen(function* () {
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
          yield* RpcServer.make(ServerWsRpcGroup, WS_RPC_SERVER_OPTIONS).pipe(
            Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(protocol)),
            Effect.provide(
              Layer.merge(
                RpcAuthorization.layer(session.scopes, (method, payload) => {
                  // Anonymous product signal: the feature and its enum variant,
                  // credited to the connecting client's surface only.
                  const usage = featureUsage(method, payload);
                  return usage === undefined
                    ? Effect.void
                    : analytics
                        .record("feature.used", {
                          ...usage,
                          ...(clientAnalyticsProps.surface === undefined
                            ? {}
                            : { surface: clientAnalyticsProps.surface }),
                        })
                        .pipe(Effect.ignore);
                }),
                rpcInstrumentationLayer,
              ),
            ),
            Effect.forkScoped,
          );
          return httpEffect;
        }).pipe(
          Effect.provide(
            layerWsRpc(session, clientAnalyticsProps, serverBrowser).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              // Handler-context reporters see only request defects, not server-wide defects.
              Layer.provide(DefectReporter.layer),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
              Layer.provide(AgentSessionScanner.layer),
              Layer.provide(ProviderMaintenanceRunner.layer),
              Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
              // Share server-lifetime PR caches so WS mutations invalidate every client's HTTP diffs.
              Layer.provide(Layer.succeed(PullRequestService.PullRequestService, pullRequests)),
              Layer.provide(OtlpEndpointCheck.layer),
              Layer.provide(
                Layer.succeed(
                  PullRequestReviewGuideService.PullRequestReviewGuideService,
                  reviewGuides,
                ),
              ),
              Layer.provide(Layer.succeed(PeerLinks.PeerLinks, peerLinks)),
              Layer.provide(Layer.succeed(PeerLinkRequests.PeerLinkRequests, peerLinkRequests)),
              Layer.provide(
                SourceControlDiscovery.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(SourceControlBuiltInDrivers.layer),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () =>
            Effect.raceFirst(
              rpcWebSocketHttpEffect,
              sessions.awaitInvalidation(session.sessionId).pipe(
                Effect.as(HttpServerResponse.empty()),
                Effect.catchTags({
                  SessionCredentialVerificationError: (error) =>
                    failEnvironmentInternal("internal_error", error),
                }),
              ),
            ),
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
