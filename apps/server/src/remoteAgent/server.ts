import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import {
  type ProjectEntry,
  type ProviderSessionStartInput,
  T3_REMOTE_HELPER_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, FileSystem, Layer, Path, Schema, Scope, Stream } from "effect";

import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { GitManager } from "../git/Services/GitManager.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  REMOTE_HELPER_METHODS,
  REMOTE_HELPER_NOTIFICATION_METHODS,
  type RemoteHelperFailure,
  type RemoteHelperHostCapabilities,
  type RemoteHelperNotification,
  type RemoteHelperRequest,
  type RemoteHelperSuccess,
} from "../remote/protocol.ts";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "../serverLayers.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { searchWorkspaceEntries } from "../workspaceEntries.ts";
import { version } from "../../package.json" with { type: "json" };

const helperStateDir = path.join(process.cwd(), ".t3-remote-agent");

const RemoteAgentLayerLive = Layer.empty.pipe(
  Layer.provideMerge(makeServerRuntimeServicesLayer()),
  Layer.provideMerge(makeServerProviderLayer()),
  Layer.provideMerge(SqlitePersistence.layerConfig),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), helperStateDir)),
  Layer.provideMerge(AnalyticsService.layerTest),
  Layer.provideMerge(NodeServices.layer),
);

const REMOTE_HELPER_CAPABILITIES = [
  REMOTE_HELPER_METHODS.hostPing,
  REMOTE_HELPER_METHODS.hostGetCapabilities,
  REMOTE_HELPER_METHODS.providerStartSession,
  REMOTE_HELPER_METHODS.providerSendTurn,
  REMOTE_HELPER_METHODS.providerInterruptTurn,
  REMOTE_HELPER_METHODS.providerRespondToRequest,
  REMOTE_HELPER_METHODS.providerRespondToUserInput,
  REMOTE_HELPER_METHODS.providerStopSession,
  REMOTE_HELPER_METHODS.providerListSessions,
  REMOTE_HELPER_METHODS.terminalOpen,
  REMOTE_HELPER_METHODS.terminalWrite,
  REMOTE_HELPER_METHODS.terminalResize,
  REMOTE_HELPER_METHODS.terminalClear,
  REMOTE_HELPER_METHODS.terminalRestart,
  REMOTE_HELPER_METHODS.terminalClose,
  REMOTE_HELPER_METHODS.workspaceSearchEntries,
  REMOTE_HELPER_METHODS.workspaceBrowseEntries,
  REMOTE_HELPER_METHODS.workspaceWriteFile,
  REMOTE_HELPER_METHODS.gitStatus,
  REMOTE_HELPER_METHODS.gitPull,
  REMOTE_HELPER_METHODS.gitRunStackedAction,
  REMOTE_HELPER_METHODS.gitListBranches,
  REMOTE_HELPER_METHODS.gitCreateWorktree,
  REMOTE_HELPER_METHODS.gitRemoveWorktree,
  REMOTE_HELPER_METHODS.gitCreateBranch,
  REMOTE_HELPER_METHODS.gitCheckout,
  REMOTE_HELPER_METHODS.gitInit,
  REMOTE_HELPER_METHODS.checkpointIsGitRepository,
  REMOTE_HELPER_METHODS.checkpointCapture,
  REMOTE_HELPER_METHODS.checkpointHasRef,
  REMOTE_HELPER_METHODS.checkpointRestore,
  REMOTE_HELPER_METHODS.checkpointDiff,
  REMOTE_HELPER_METHODS.checkpointDeleteRefs,
] as const satisfies ReadonlyArray<string>;

type HelperResponse =
  | RemoteHelperSuccess<unknown>
  | RemoteHelperFailure
  | RemoteHelperNotification<unknown>;

class RemoteAgentRequestError extends Schema.TaggedErrorClass<RemoteAgentRequestError>()(
  "RemoteAgentRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

function resolveRemotePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

function mapSearchEntryToAbsolute(cwd: string, entry: ProjectEntry): ProjectEntry {
  return {
    ...entry,
    path: path.resolve(cwd, entry.path),
    ...(entry.parentPath ? { parentPath: path.resolve(cwd, entry.parentPath) } : {}),
  };
}

async function browseDirectory(input: {
  readonly cwd: string;
  readonly limit: number;
}): Promise<{
  readonly cwd: string;
  readonly entries: ReadonlyArray<{
    readonly path: string;
    readonly kind: "file" | "directory";
    readonly parentPath?: string | undefined;
  }>;
  readonly truncated: boolean;
}> {
  const cwd = resolveRemotePath(input.cwd);
  const directoryEntries = await fs.readdir(cwd, { withFileTypes: true });
  const sortedEntries = directoryEntries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .toSorted((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  const limitedEntries = sortedEntries.slice(0, input.limit);
  return {
    cwd,
    entries: limitedEntries.map((entry) => ({
      path: path.join(cwd, entry.name),
      kind: entry.isDirectory() ? "directory" : "file",
      parentPath: cwd,
    })),
    truncated: sortedEntries.length > limitedEntries.length,
  };
}

function helperCapabilities(): RemoteHelperHostCapabilities {
  return {
    protocolVersion: T3_REMOTE_HELPER_PROTOCOL_VERSION,
    helperVersion: version,
    capabilities: Array.from(REMOTE_HELPER_CAPABILITIES),
  };
}

export const makeRemoteAgentProgram = () =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const terminalManager = yield* TerminalManager;
    const gitManager = yield* GitManager;
    const git = yield* GitCore;
    const checkpointStore = yield* CheckpointStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;

    const runtimeServices = yield* Effect.services<
      | ProviderService
      | TerminalManager
      | GitManager
      | GitCore
      | CheckpointStore
      | FileSystem.FileSystem
      | Path.Path
    >();
    const runPromise = Effect.runPromiseWith(runtimeServices);

    let writeQueue = Promise.resolve();
    const writeMessage = (message: HelperResponse): Promise<void> => {
      writeQueue = writeQueue
        .then(
          () =>
            new Promise<void>((resolve, reject) => {
              process.stdout.write(`${JSON.stringify(message)}\n`, (error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              });
            }),
        )
        .catch(() => undefined);
      return writeQueue;
    };

    const subscriptionsScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

    yield* Stream.runForEach(providerService.streamEvents, (event) =>
      Effect.sync(() => {
        void writeMessage({
          jsonrpc: "2.0",
          method: REMOTE_HELPER_NOTIFICATION_METHODS.providerEvent,
          params: event,
        });
      }),
    ).pipe(Effect.forkIn(subscriptionsScope));

    const unsubscribeTerminalEvents = yield* terminalManager.subscribe((event) => {
      void writeMessage({
        jsonrpc: "2.0",
        method: REMOTE_HELPER_NOTIFICATION_METHODS.terminalEvent,
        params: event,
      });
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));

    const handleRequest = (request: RemoteHelperRequest<unknown>) =>
      Effect.gen(function* () {
        switch (request.method) {
          case REMOTE_HELPER_METHODS.hostPing:
            return {
              protocolVersion: T3_REMOTE_HELPER_PROTOCOL_VERSION,
              helperVersion: version,
            };

          case REMOTE_HELPER_METHODS.hostGetCapabilities:
            return helperCapabilities();

          case REMOTE_HELPER_METHODS.providerStartSession: {
            const params = request.params as ProviderSessionStartInput;
            return yield* providerService.startSession(params.threadId, params);
          }

          case REMOTE_HELPER_METHODS.providerSendTurn:
            return yield* providerService.sendTurn(
              request.params as Parameters<typeof providerService.sendTurn>[0],
            );

          case REMOTE_HELPER_METHODS.providerInterruptTurn:
            return yield* providerService.interruptTurn(
              request.params as Parameters<typeof providerService.interruptTurn>[0],
            );

          case REMOTE_HELPER_METHODS.providerRespondToRequest:
            return yield* providerService.respondToRequest(
              request.params as Parameters<typeof providerService.respondToRequest>[0],
            );

          case REMOTE_HELPER_METHODS.providerRespondToUserInput:
            return yield* providerService.respondToUserInput(
              request.params as Parameters<typeof providerService.respondToUserInput>[0],
            );

          case REMOTE_HELPER_METHODS.providerStopSession:
            return yield* providerService.stopSession(
              request.params as Parameters<typeof providerService.stopSession>[0],
            );

          case REMOTE_HELPER_METHODS.providerListSessions:
            return yield* providerService.listSessions();

          case REMOTE_HELPER_METHODS.providerReadThread:
          case REMOTE_HELPER_METHODS.providerRollbackThread:
            return yield* Effect.fail(
              new Error(`Remote helper method not implemented: ${request.method}`),
            );

          case REMOTE_HELPER_METHODS.terminalOpen:
            return yield* terminalManager.open(
              request.params as Parameters<typeof terminalManager.open>[0],
            );

          case REMOTE_HELPER_METHODS.terminalWrite:
            return yield* terminalManager.write(
              request.params as Parameters<typeof terminalManager.write>[0],
            );

          case REMOTE_HELPER_METHODS.terminalResize:
            return yield* terminalManager.resize(
              request.params as Parameters<typeof terminalManager.resize>[0],
            );

          case REMOTE_HELPER_METHODS.terminalClear:
            return yield* terminalManager.clear(
              request.params as Parameters<typeof terminalManager.clear>[0],
            );

          case REMOTE_HELPER_METHODS.terminalRestart:
            return yield* terminalManager.restart(
              request.params as Parameters<typeof terminalManager.restart>[0],
            );

          case REMOTE_HELPER_METHODS.terminalClose:
            return yield* terminalManager.close(
              request.params as Parameters<typeof terminalManager.close>[0],
            );

          case REMOTE_HELPER_METHODS.workspaceSearchEntries: {
            const params = request.params as {
              readonly cwd: string;
              readonly query: string;
              readonly limit: number;
            };
            const cwd = resolveRemotePath(params.cwd);
            return yield* Effect.tryPromise({
              try: async () => {
                const result = await searchWorkspaceEntries({
                  cwd,
                  query: params.query,
                  limit: params.limit,
                });
                return {
                  ...result,
                  entries: result.entries.map((entry) => mapSearchEntryToAbsolute(cwd, entry)),
                };
              },
              catch: (cause) =>
                new RemoteAgentRequestError({
                  message: `Failed to search workspace entries: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`,
                  cause,
                }),
            });
          }

          case REMOTE_HELPER_METHODS.workspaceBrowseEntries:
            return yield* Effect.tryPromise({
              try: () =>
                browseDirectory(
                  request.params as {
                    readonly cwd: string;
                    readonly limit: number;
                  },
                ),
              catch: (cause) =>
                new RemoteAgentRequestError({
                  message: `Failed to browse workspace entries: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`,
                  cause,
                }),
            });

          case REMOTE_HELPER_METHODS.workspaceWriteFile: {
            const params = request.params as {
              readonly workspaceRoot: string;
              readonly relativePath: string;
              readonly contents: string;
            };
            const workspaceRoot = resolveRemotePath(params.workspaceRoot);
            const absolutePath = pathService.resolve(workspaceRoot, params.relativePath);
            yield* fileSystem.makeDirectory(pathService.dirname(absolutePath), {
              recursive: true,
            });
            yield* fileSystem.writeFileString(absolutePath, params.contents);
            return { relativePath: params.relativePath };
          }

          case REMOTE_HELPER_METHODS.gitStatus:
            return yield* git.status(request.params as Parameters<typeof git.status>[0]);

          case REMOTE_HELPER_METHODS.gitPull: {
            const params = request.params as { readonly cwd: string };
            return yield* git.pullCurrentBranch(params.cwd);
          }

          case REMOTE_HELPER_METHODS.gitRunStackedAction:
            return yield* gitManager.runStackedAction(
              request.params as Parameters<typeof gitManager.runStackedAction>[0],
            );

          case REMOTE_HELPER_METHODS.gitListBranches:
            return yield* git.listBranches(request.params as Parameters<typeof git.listBranches>[0]);

          case REMOTE_HELPER_METHODS.gitCreateWorktree:
            return yield* git.createWorktree(
              request.params as Parameters<typeof git.createWorktree>[0],
            );

          case REMOTE_HELPER_METHODS.gitRemoveWorktree:
            return yield* git.removeWorktree(
              request.params as Parameters<typeof git.removeWorktree>[0],
            );

          case REMOTE_HELPER_METHODS.gitCreateBranch:
            return yield* git.createBranch(
              request.params as Parameters<typeof git.createBranch>[0],
            );

          case REMOTE_HELPER_METHODS.gitCheckout:
            return yield* Effect.scoped(
              git.checkoutBranch(request.params as Parameters<typeof git.checkoutBranch>[0]),
            );

          case REMOTE_HELPER_METHODS.gitInit:
            return yield* git.initRepo(request.params as Parameters<typeof git.initRepo>[0]);

          case REMOTE_HELPER_METHODS.checkpointIsGitRepository: {
            const params = request.params as { readonly cwd: string };
            return yield* checkpointStore.isGitRepository(params.cwd);
          }

          case REMOTE_HELPER_METHODS.checkpointCapture:
            return yield* checkpointStore.captureCheckpoint(
              request.params as Parameters<typeof checkpointStore.captureCheckpoint>[0],
            );

          case REMOTE_HELPER_METHODS.checkpointHasRef:
            return yield* checkpointStore.hasCheckpointRef(
              request.params as Parameters<typeof checkpointStore.hasCheckpointRef>[0],
            );

          case REMOTE_HELPER_METHODS.checkpointRestore:
            return yield* checkpointStore.restoreCheckpoint(
              request.params as Parameters<typeof checkpointStore.restoreCheckpoint>[0],
            );

          case REMOTE_HELPER_METHODS.checkpointDiff:
            return yield* checkpointStore.diffCheckpoints(
              request.params as Parameters<typeof checkpointStore.diffCheckpoints>[0],
            );

          case REMOTE_HELPER_METHODS.checkpointDeleteRefs:
            return yield* checkpointStore.deleteCheckpointRefs(
              request.params as Parameters<typeof checkpointStore.deleteCheckpointRefs>[0],
            );

          default:
            return yield* Effect.fail(
              new Error(`Remote helper method not implemented: ${request.method}`),
            );
        }
      });

    const input = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      terminal: false,
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => input.close()));

    input.on("line", (line) => {
      if (line.trim().length === 0) {
        return;
      }

      let request: RemoteHelperRequest<unknown>;
      try {
        request = JSON.parse(line) as RemoteHelperRequest<unknown>;
      } catch (error) {
        void writeMessage({
          jsonrpc: "2.0",
          id: "unknown",
          error: {
            code: -32700,
            message: error instanceof Error ? error.message : "Invalid JSON-RPC request.",
          },
        });
        return;
      }

      void runPromise(Effect.exit(handleRequest(request))).then((exit) => {
        const message: HelperResponse =
          exit._tag === "Success"
            ? {
                jsonrpc: "2.0",
                id: request.id,
                result: exit.value,
              }
            : {
                jsonrpc: "2.0",
                id: request.id,
                error: {
                  code: -32000,
                  message: String(Cause.squash(exit.cause)),
                },
              };
        void writeMessage(message);
      });
    });

    return yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          input.on("close", () => {
            resolve();
          });
        }),
    );
  }).pipe(Effect.scoped, Effect.provide(RemoteAgentLayerLive));
