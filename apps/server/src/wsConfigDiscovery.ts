import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
  CLIENT_CAPABILITIES_QUERY_PARAM,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
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
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";

const CONFIG_DISCOVERY_TIMEOUT = Duration.seconds(5);
export const isProviderUploadFeedbackError = Schema.is(ProviderUploadFeedbackError);

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

export const withLateConfigDiscovery = <E, R>(
  config: ClientServerConfig,
  liveUpdates: Stream.Stream<ServerConfigStreamEvent, E, R>,
  launcher: EditorDiscovery,
  remoteOpenTargets: RemoteOpenTargets.RemoteOpenTargets["Service"],
  directEndpoints: Pick<DirectEndpoints.DirectEndpoints["Service"], "resolve">,
) => {
  const lateEditorConfig = Stream.fromEffect(launcher.resolveAvailableEditors()).pipe(
    Stream.filter(
      (editors) =>
        editors.join() !== config.availableEditors.join() ||
        (editors.includes("file-manager") && config.shellRevealInFileManagerKind === undefined),
    ),
    // Unbounded, unlike the snapshot: this exists to deliver a probe that
    // outlasts the snapshot's timeout.
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

  const lateRemoteOpenTargets = Stream.fromEffect(remoteOpenTargets.resolveTargets()).pipe(
    Stream.filter(
      (targets) => JSON.stringify(targets) !== JSON.stringify(config.remoteOpenTargets ?? []),
    ),
    Stream.map((targets) => ({ type: "remoteOpenTargetsResolved" as const, targets })),
  );

  const lateDirectEndpoints = Stream.fromEffect(directEndpoints.resolve()).pipe(
    Stream.catchCause(() => Stream.empty),
    Stream.map((endpoints) => ({ type: "directEndpointsResolved" as const, endpoints })),
  );

  return Stream.merge(
    liveUpdates,
    Stream.merge(lateEditorConfig, Stream.merge(lateRemoteOpenTargets, lateDirectEndpoints)),
  ).pipe(
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
          case "remoteOpenTargetsResolved": {
            const next = { ...current, remoteOpenTargets: event.targets };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
          case "directEndpointsResolved": {
            if (JSON.stringify(current.directEndpoints ?? []) === JSON.stringify(event.endpoints)) {
              return [current, []];
            }
            const next = { ...current, directEndpoints: event.endpoints };
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

// Discoveries run side by side so the slowest one, not their sum, bounds the
// server config snapshot. Each degrades on timeout rather than failing it.
export const resolveOpenDiscoveryForConfig = <T, D, E1, R1, E2, R2, E3, R3, E4, R4>(discovery: {
  readonly editors: Effect.Effect<ReadonlyArray<EditorId>, E1, R1>;
  readonly fileManagerRevealKind: Effect.Effect<FileManagerRevealKind | undefined, E2, R2>;
  readonly remoteOpenTargets: Effect.Effect<ReadonlyArray<T>, E3, R3>;
  readonly directEndpoints: Effect.Effect<ReadonlyArray<D>, E4, R4>;
}) =>
  Effect.all(
    {
      editorConfig: resolveAvailableEditorsForConfig(discovery.editors).pipe(
        Effect.flatMap((availableEditors) =>
          resolveEditorConfig(
            availableEditors,
            resolveFileManagerRevealKindForConfig(discovery.fileManagerRevealKind),
          ),
        ),
      ),
      // Same discovery-with-timeout treatment as editors: a slow probe must
      // not stall server.getConfig, so it degrades to an empty list.
      remoteOpenTargets: resolveAvailableEditorsForConfig(discovery.remoteOpenTargets),
      directEndpoints: resolveAvailableEditorsForConfig(discovery.directEndpoints),
    },
    { concurrency: "unbounded" },
  ).pipe(Effect.map(({ editorConfig, ...endpoints }) => ({ ...editorConfig, ...endpoints })));
