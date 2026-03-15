import {
  ClientOrchestrationCommand,
  GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  type GitResolvePullRequestResult,
  type OrchestrationCommand,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ServerRpcError,
  ServerRpcGroup,
  TerminalEvent,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Queue, Stream } from "effect";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { createAttachmentId, resolveAttachmentPath } from "./attachmentStore.ts";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { ServerConfig as RuntimeServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";
import { GitManager } from "./git/Services/GitManager.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { Keybindings } from "./keybindings";
import { Open, resolveAvailableEditors } from "./open";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { ProviderService } from "./provider/Services/ProviderService";
import { ServerRuntimeState } from "./serverRuntime";
import { searchWorkspaceEntries } from "./workspaceEntries";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import type { TerminalManagerShape } from "./terminal/Services/Manager.ts";

export type ServerRpcRouteRequirements =
  | RuntimeServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | GitManager
  | GitCore
  | Keybindings
  | Open
  | OrchestrationEngineService
  | CheckpointDiffQuery
  | ProjectionSnapshotQuery
  | ProviderHealth
  | ProviderService
  | ServerRuntimeState
  | TerminalManager;

function formatRpcError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const serverRpcError = (message: string): ServerRpcError => ({ message });

const mapRpcError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((error) => serverRpcError(formatRpcError(error))));

const mapRpcStreamError = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(Stream.mapError((error) => serverRpcError(formatRpcError(error))));

const textResponse = (status: number, body: string) =>
  HttpServerResponse.text(body, { status, contentType: "text/plain" });

const normalizeDispatchCommand = Effect.fn(function* (input: {
  readonly command: ClientOrchestrationCommand;
}) {
  if (input.command.type !== "thread.turn.start") {
    return input.command as OrchestrationCommand;
  }
  const turnStartCommand = input.command;

  const serverConfig = yield* RuntimeServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const normalizedAttachments = yield* Effect.forEach(
    turnStartCommand.message.attachments,
    (attachment) =>
      Effect.gen(function* () {
        const parsed = parseBase64DataUrl(attachment.dataUrl);
        if (!parsed || !parsed.mimeType.startsWith("image/")) {
          return yield* Effect.fail(
            serverRpcError(`Invalid image attachment payload for '${attachment.name}'.`),
          );
        }

        const bytes = Buffer.from(parsed.base64, "base64");
        if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          return yield* Effect.fail(
            serverRpcError(`Image attachment '${attachment.name}' is empty or too large.`),
          );
        }

        const attachmentId = createAttachmentId(turnStartCommand.threadId);
        if (!attachmentId) {
          return yield* Effect.fail(serverRpcError("Failed to create a safe attachment id."));
        }

        const persistedAttachment = {
          type: "image" as const,
          id: attachmentId,
          name: attachment.name,
          mimeType: parsed.mimeType.toLowerCase(),
          sizeBytes: bytes.byteLength,
        };

        const attachmentPath = resolveAttachmentPath({
          stateDir: serverConfig.stateDir,
          attachment: persistedAttachment,
        });
        if (!attachmentPath) {
          return yield* Effect.fail(
            serverRpcError(`Failed to resolve persisted path for '${attachment.name}'.`),
          );
        }

        yield* fileSystem
          .makeDirectory(path.dirname(attachmentPath), { recursive: true })
          .pipe(
            Effect.mapError(() =>
              serverRpcError(`Failed to create attachment directory for '${attachment.name}'.`),
            ),
          );
        yield* fileSystem
          .writeFile(attachmentPath, bytes)
          .pipe(
            Effect.mapError(() =>
              serverRpcError(`Failed to persist attachment '${attachment.name}'.`),
            ),
          );

        return persistedAttachment;
      }),
    { concurrency: 1 },
  );

  return {
    ...turnStartCommand,
    message: {
      ...turnStartCommand.message,
      attachments: normalizedAttachments,
    },
  } satisfies OrchestrationCommand;
});

const makeTerminalEventStream = (terminalManager: TerminalManagerShape) =>
  Stream.callback<TerminalEvent>((queue) =>
    Effect.acquireRelease(
      terminalManager.subscribe((event: TerminalEvent) => {
        Queue.offerUnsafe(queue, event);
      }),
      (unsubscribe) => Effect.sync(() => unsubscribe()),
    ).pipe(Effect.asVoid),
  );

export const makeServerRpcHandlersLayer = Layer.unwrap(
  Effect.gen(function* () {
    const serverConfig = yield* RuntimeServerConfig;
    const gitManager = yield* GitManager;
    const git = yield* GitCore;
    const keybindingsManager = yield* Keybindings;
    const open = yield* Open;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const providerHealth = yield* ProviderHealth;
    const serverRuntime = yield* ServerRuntimeState;
    const terminalManager = yield* TerminalManager;

    const availableEditors = resolveAvailableEditors();

    const loadServerConfig = Effect.gen(function* () {
      const keybindingsConfig = yield* keybindingsManager.loadConfigState;
      const providerStatuses = yield* providerHealth.getStatuses;
      return {
        cwd: serverConfig.cwd,
        keybindingsConfigPath: serverConfig.keybindingsConfigPath,
        keybindings: keybindingsConfig.keybindings,
        issues: keybindingsConfig.issues,
        providers: providerStatuses,
        availableEditors,
      };
    });

    return ServerRpcGroup.toLayer({
      getBootstrap: () => Effect.succeed(serverRuntime.bootstrapState),
      getServerConfig: () => mapRpcError(loadServerConfig),
      upsertKeybinding: (input) =>
        mapRpcError(
          keybindingsManager
            .upsertKeybindingRule(input)
            .pipe(Effect.map((keybindings) => ({ keybindings, issues: [] }))),
        ),
      subscribeServerConfig: () =>
        mapRpcStreamError(
          keybindingsManager.streamChanges.pipe(
            Stream.mapEffect((event) =>
              providerHealth.getStatuses.pipe(
                Effect.map((providers) => ({
                  issues: event.issues,
                  providers,
                })),
              ),
            ),
          ),
        ),
      getSnapshot: () => mapRpcError(projectionSnapshotQuery.getSnapshot()),
      dispatchCommand: (command) =>
        mapRpcError(
          normalizeDispatchCommand({ command }).pipe(
            Effect.flatMap((normalizedCommand) => orchestrationEngine.dispatch(normalizedCommand)),
          ),
        ),
      getTurnDiff: (input) => mapRpcError(checkpointDiffQuery.getTurnDiff(input)),
      getFullThreadDiff: (input) => mapRpcError(checkpointDiffQuery.getFullThreadDiff(input)),
      replayEvents: (input) =>
        mapRpcError(
          Stream.runCollect(
            orchestrationEngine.readEvents(
              clamp(input.fromSequenceExclusive, {
                maximum: Number.MAX_SAFE_INTEGER,
                minimum: 0,
              }),
            ),
          ).pipe(Effect.map((events) => Array.from(events))),
        ),
      subscribeDomainEvents: () => mapRpcStreamError(orchestrationEngine.streamDomainEvents),
      searchEntries: (input) =>
        mapRpcError(
          Effect.tryPromise({
            try: () => searchWorkspaceEntries(input),
            catch: (cause) => serverRpcError(`Failed to search workspace entries: ${String(cause)}`),
          }),
        ),
      openInEditor: (input) => mapRpcError(open.openInEditor(input)),
      gitStatus: (input) => mapRpcError(gitManager.status(input)),
      gitPull: (input) => mapRpcError(git.pullCurrentBranch(input.cwd)),
      gitRunStackedAction: (input) => mapRpcError(gitManager.runStackedAction(input)),
      gitListBranches: (input) => mapRpcError(git.listBranches(input)),
      gitCreateWorktree: (input) => mapRpcError(git.createWorktree(input)),
      gitRemoveWorktree: (input) => mapRpcError(git.removeWorktree(input)),
      gitCreateBranch: (input) => mapRpcError(git.createBranch(input)),
      gitCheckout: (input) => mapRpcError(Effect.scoped(git.checkoutBranch(input))),
      gitInit: (input) => mapRpcError(git.initRepo(input)),
      gitResolvePullRequest: (input: GitPullRequestRefInput) =>
        mapRpcError(
          gitManager.resolvePullRequest(input) as Effect.Effect<
            GitResolvePullRequestResult,
            never,
            never
          >,
        ),
      gitPreparePullRequestThread: (input: GitPreparePullRequestThreadInput) =>
        mapRpcError(
          gitManager.preparePullRequestThread(input) as Effect.Effect<
            GitPreparePullRequestThreadResult,
            never,
            never
          >,
        ),
      terminalOpen: (input) => mapRpcError(terminalManager.open(input)),
      terminalWrite: (input) => mapRpcError(terminalManager.write(input)),
      terminalResize: (input) => mapRpcError(terminalManager.resize(input)),
      terminalClear: (input) => mapRpcError(terminalManager.clear(input)),
      terminalRestart: (input) => mapRpcError(terminalManager.restart(input)),
      terminalClose: (input) => mapRpcError(terminalManager.close(input)),
      subscribeTerminalEvents: () => mapRpcStreamError(makeTerminalEventStream(terminalManager)),
    });
  }),
);

export const makeServerRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const serverConfig = yield* RuntimeServerConfig;
    const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;

    const websocketRpcRoute = HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (!url) {
          return textResponse(400, "Invalid WebSocket URL");
        }
        if (request.headers.upgrade?.toLowerCase() !== "websocket") {
          return textResponse(400, "Expected WebSocket upgrade request");
        }
        if (serverConfig.authToken && url.searchParams.get("token") !== serverConfig.authToken) {
          return textResponse(401, "Unauthorized WebSocket connection");
        }
        return yield* httpEffect;
      }),
    );

    return RpcServer.layer(ServerRpcGroup).pipe(
      Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
      Layer.provide(makeServerRpcHandlersLayer),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provideMerge(websocketRpcRoute),
    );
  }).pipe(Effect.provide(RpcSerialization.layerJson)),
);
