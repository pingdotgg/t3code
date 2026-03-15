import { Effect, FileSystem, Layer, Option, Path, Schema, Stream, PubSub, Ref } from "effect";
import {
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  type TerminalEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore";
import { GitManager } from "./git/Services/GitManager";
import { Keybindings } from "./keybindings";
import { Open, resolveAvailableEditors } from "./open";
import { normalizeDispatchCommand } from "./orchestration/Normalizer";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { TerminalManager } from "./terminal/Services/Manager";
import { resolveWorkspaceWritePath, searchWorkspaceEntries } from "./workspaceEntries";

const WsRpcLayer = WsRpcGroup.toLayer(
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    const keybindings = yield* Keybindings;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const open = yield* Open;
    const gitManager = yield* GitManager;
    const git = yield* GitCore;
    const terminalManager = yield* TerminalManager;
    const providerHealth = yield* ProviderHealth;
    const config = yield* ServerConfig;
    const lifecycleEvents = yield* ServerLifecycleEvents;
    const startup = yield* ServerRuntimeStartup;

    return WsRpcGroup.of({
      [ORCHESTRATION_WS_METHODS.getSnapshot]: (_input) =>
        projectionSnapshotQuery.getSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load orchestration snapshot",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
        Effect.gen(function* () {
          const normalizedCommand = yield* normalizeDispatchCommand(command);
          return yield* startup.enqueueCommand(orchestrationEngine.dispatch(normalizedCommand));
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(OrchestrationDispatchCommandError)(cause)
              ? cause
              : new OrchestrationDispatchCommandError({
                  message: "Failed to dispatch orchestration command",
                  cause,
                }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
        checkpointDiffQuery.getTurnDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetTurnDiffError({
                message: "Failed to load turn diff",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
        checkpointDiffQuery.getFullThreadDiff(input).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetFullThreadDiffError({
                message: "Failed to load full thread diff",
                cause,
              }),
          ),
        ),
      [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
        Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(input.fromSequenceExclusive, { maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
          ),
        ).pipe(
          Effect.map((events) => Array.from(events)),
          Effect.mapError(
            (cause) =>
              new OrchestrationReplayEventsError({
                message: "Failed to replay orchestration events",
                cause,
              }),
          ),
        ),
      [WS_METHODS.subscribeOrchestrationDomainEvents]: (_input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const snapshot = yield* orchestrationEngine.getReadModel();
            const fromSequenceExclusive = snapshot.snapshotSequence;
            const replayEvents: Array<OrchestrationEvent> = yield* Stream.runCollect(
              orchestrationEngine.readEvents(fromSequenceExclusive),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.catch(() => Effect.succeed([] as Array<OrchestrationEvent>)),
            );
            const replayStream = Stream.fromIterable(replayEvents);
            const source = Stream.merge(replayStream, orchestrationEngine.streamDomainEvents);
            type SequenceState = {
              readonly nextSequence: number;
              readonly pendingBySequence: Map<number, OrchestrationEvent>;
            };
            const state = yield* Ref.make<SequenceState>({
              nextSequence: fromSequenceExclusive + 1,
              pendingBySequence: new Map<number, OrchestrationEvent>(),
            });

            return source.pipe(
              Stream.mapEffect((event) =>
                Ref.modify(
                  state,
                  ({
                    nextSequence,
                    pendingBySequence,
                  }): [Array<OrchestrationEvent>, SequenceState] => {
                    if (event.sequence < nextSequence || pendingBySequence.has(event.sequence)) {
                      return [[], { nextSequence, pendingBySequence }];
                    }

                    const updatedPending = new Map(pendingBySequence);
                    updatedPending.set(event.sequence, event);

                    const emit: Array<OrchestrationEvent> = [];
                    let expected = nextSequence;
                    for (;;) {
                      const expectedEvent = updatedPending.get(expected);
                      if (!expectedEvent) {
                        break;
                      }
                      emit.push(expectedEvent);
                      updatedPending.delete(expected);
                      expected += 1;
                    }

                    return [emit, { nextSequence: expected, pendingBySequence: updatedPending }];
                  },
                ),
              ),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            );
          }),
        ),
      [WS_METHODS.serverUpsertKeybinding]: (rule) =>
        Effect.gen(function* () {
          const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
          return { keybindings: keybindingsConfig, issues: [] };
        }),
      [WS_METHODS.projectsSearchEntries]: (input) =>
        Effect.tryPromise({
          try: () => searchWorkspaceEntries(input),
          catch: (cause) =>
            new ProjectSearchEntriesError({
              message: "Failed to search workspace entries",
              cause,
            }),
        }),
      [WS_METHODS.projectsWriteFile]: (input) =>
        Effect.gen(function* () {
          const target = yield* resolveWorkspaceWritePath({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
          });
          yield* fileSystem
            .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectWriteFileError({
                    message: "Failed to prepare workspace path",
                    cause,
                  }),
              ),
            );
          yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectWriteFileError({
                  message: "Failed to write workspace file",
                  cause,
                }),
            ),
          );
          return { relativePath: target.relativePath };
        }),
      [WS_METHODS.shellOpenInEditor]: (input) => open.openInEditor(input),
      [WS_METHODS.gitStatus]: (input) => gitManager.status(input),
      [WS_METHODS.gitPull]: (input) => git.pullCurrentBranch(input.cwd),
      [WS_METHODS.gitRunStackedAction]: (input) => gitManager.runStackedAction(input),
      [WS_METHODS.gitResolvePullRequest]: (input) => gitManager.resolvePullRequest(input),
      [WS_METHODS.gitPreparePullRequestThread]: (input) =>
        gitManager.preparePullRequestThread(input),
      [WS_METHODS.gitListBranches]: (input) => git.listBranches(input),
      [WS_METHODS.gitCreateWorktree]: (input) => git.createWorktree(input),
      [WS_METHODS.gitRemoveWorktree]: (input) => git.removeWorktree(input),
      [WS_METHODS.gitCreateBranch]: (input) => git.createBranch(input),
      [WS_METHODS.gitCheckout]: (input) => Effect.scoped(git.checkoutBranch(input)),
      [WS_METHODS.gitInit]: (input) => git.initRepo(input),
      [WS_METHODS.terminalOpen]: (input) => terminalManager.open(input),
      [WS_METHODS.terminalWrite]: (input) => terminalManager.write(input),
      [WS_METHODS.terminalResize]: (input) => terminalManager.resize(input),
      [WS_METHODS.terminalClear]: (input) => terminalManager.clear(input),
      [WS_METHODS.terminalRestart]: (input) => terminalManager.restart(input),
      [WS_METHODS.terminalClose]: (input) => terminalManager.close(input),
      [WS_METHODS.subscribeTerminalEvents]: (_input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const pubsub = yield* PubSub.unbounded<TerminalEvent>();
            const unsubscribe = yield* terminalManager.subscribe((event) => {
              PubSub.publishUnsafe(pubsub, event);
            });
            return Stream.fromPubSub(pubsub).pipe(
              Stream.ensuring(Effect.sync(() => unsubscribe())),
            );
          }),
        ),
      [WS_METHODS.subscribeServerConfig]: (_input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const keybindingsConfig = yield* keybindings.loadConfigState;
            const providers = yield* providerHealth.getStatuses;

            const keybindingsUpdates = keybindings.streamChanges.pipe(
              Stream.mapEffect((event) =>
                Effect.succeed({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    issues: event.issues,
                  },
                }),
              ),
            );
            const providerStatuses = Stream.tick("10 seconds").pipe(
              Stream.mapEffect(() =>
                Effect.gen(function* () {
                  const providers = yield* providerHealth.getStatuses;
                  return {
                    version: 1 as const,
                    type: "providerStatuses" as const,
                    payload: { providers },
                  };
                }),
              ),
            );
            return Stream.concat(
              Stream.make({
                version: 1 as const,
                type: "snapshot" as const,
                config: {
                  cwd: config.cwd,
                  keybindingsConfigPath: config.keybindingsConfigPath,
                  keybindings: keybindingsConfig.keybindings,
                  issues: keybindingsConfig.issues,
                  providers,
                  availableEditors: resolveAvailableEditors(),
                },
              }),
              Stream.merge(keybindingsUpdates, providerStatuses),
            );
          }),
        ),
      [WS_METHODS.subscribeServerLifecycle]: (_input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const snapshot = yield* lifecycleEvents.snapshot;
            const snapshotEvents = Array.from(snapshot.events).toSorted(
              (left, right) => left.sequence - right.sequence,
            );
            const liveEvents = lifecycleEvents.stream.pipe(
              Stream.filter((event) => event.sequence > snapshot.sequence),
            );
            return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
          }),
        ),
    });
  }),
);

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup).pipe(
      Effect.provide(Layer.mergeAll(WsRpcLayer, RpcSerialization.layerJson)),
    );
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        if (config.authToken) {
          const url = HttpServerRequest.toURL(request);
          if (Option.isNone(url)) {
            return HttpServerResponse.text("Invalid WebSocket URL", { status: 400 });
          }
          const token = url.value.searchParams.get("token");
          if (token !== config.authToken) {
            return HttpServerResponse.text("Unauthorized WebSocket connection", { status: 401 });
          }
        }
        return yield* rpcWebSocketHttpEffect;
      }),
    );
  }),
);
