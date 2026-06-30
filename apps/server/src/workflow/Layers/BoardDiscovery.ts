import {
  BoardId,
  WorkflowDefinition,
  WorkflowRpcError,
  type BoardListEntry,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { BoardDiscovery, type BoardDiscoveryShape } from "../Services/BoardDiscovery.ts";
import { ProjectWorkspaceResolver } from "../Services/ProjectWorkspaceResolver.ts";
import { WorkflowBoardVersionStore } from "../Services/WorkflowBoardVersionStore.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowFileLoader } from "../Services/WorkflowFileLoader.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowAgentSessionStore } from "../Services/WorkflowAgentSessionStore.ts";
import { WorkflowThreadJanitor } from "../Services/WorkflowThreadJanitor.ts";
import { WorkflowWebhook } from "../Services/WorkflowWebhook.ts";
import { WorkflowWorktreeJanitor } from "../Services/WorkflowWorktreeJanitor.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { deleteWorkflowBoardOwnedState } from "../boardDeletion.ts";

const decodeWorkflowDefinitionJson = Schema.decodeEffect(Schema.fromJsonString(WorkflowDefinition));

const toWorkflowRpcError = (message: string) => (cause: unknown) =>
  new WorkflowRpcError({ message, cause });

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const isJsonBoardFile = (name: string) => name.endsWith(".json");

const boardSlugFromFileName = (fileName: string): string => fileName.slice(0, -".json".length);

const boardIdFor = (projectId: ProjectId, slug: string) => BoardId.make(`${projectId}__${slug}`);

const makeEntry = (input: {
  readonly boardId: BoardId;
  readonly name: string;
  readonly relativePath: string;
  readonly error: string | null;
}): BoardListEntry => ({
  boardId: input.boardId,
  name: input.name,
  filePath: input.relativePath,
  error: input.error,
});

interface RemovedBoardCandidate {
  readonly boardId: BoardId;
  readonly filePath: string;
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolver = yield* ProjectWorkspaceResolver;
  const loader = yield* WorkflowFileLoader;
  const registry = yield* BoardRegistry;
  const readModel = yield* WorkflowReadModel;
  const saveLocks = yield* WorkflowBoardSaveLocks;
  const engine = yield* WorkflowEngine;
  const eventStore = yield* WorkflowEventStore;
  const versionStore = yield* WorkflowBoardVersionStore;
  const sql = yield* SqlClient.SqlClient;
  const worktreeJanitor = Context.getOption(
    (yield* Effect.context<never>()) as Context.Context<WorkflowWorktreeJanitor>,
    WorkflowWorktreeJanitor,
  );
  // Resolved optionally so leaner test stacks (and any layer wired without the
  // janitor) still build; when present, board-file GC reclaims the hidden
  // provider threads instead of leaking them, matching the RPC deleteBoard path.
  const threadJanitor = Context.getOption(
    (yield* Effect.context<never>()) as Context.Context<WorkflowThreadJanitor>,
    WorkflowThreadJanitor,
  );
  const webhook = Context.getOption(
    (yield* Effect.context<never>()) as Context.Context<WorkflowWebhook>,
    WorkflowWebhook,
  );
  // Optional per-agent session teardown for board-file GC, matching the RPC
  // deleteBoard path (A8).
  const agentSessions = Context.getOption(
    (yield* Effect.context<never>()) as Context.Context<WorkflowAgentSessionStore>,
    WorkflowAgentSessionStore,
  );
  const providerService = Context.getOption(
    (yield* Effect.context<never>()) as Context.Context<ProviderService>,
    ProviderService,
  );
  const cache = yield* Ref.make<Map<string, ReadonlyArray<BoardListEntry>>>(new Map());

  const discoverFile = (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly fileName: string;
  }) => {
    const slug = boardSlugFromFileName(input.fileName);
    const boardId = boardIdFor(input.projectId, slug);
    const relativePath = `.t3/boards/${input.fileName}`;
    const absolutePath = path.join(input.workspaceRoot, relativePath);

    return saveLocks.withSaveLock(
      boardId,
      Effect.gen(function* () {
        const stillExists = yield* fileSystem
          .exists(absolutePath)
          .pipe(
            Effect.mapError(toWorkflowRpcError(`Failed to check workflow board ${relativePath}`)),
          );
        if (!stillExists) {
          return null;
        }

        return yield* fileSystem.readFileString(absolutePath).pipe(
          Effect.mapError(toWorkflowRpcError(`Failed to read workflow board ${relativePath}`)),
          Effect.flatMap((raw) =>
            decodeWorkflowDefinitionJson(raw).pipe(
              Effect.matchEffect({
                onFailure: (cause) =>
                  Effect.succeed(
                    makeEntry({
                      boardId,
                      name: slug,
                      relativePath,
                      error: errorMessage(cause),
                    }),
                  ),
                onSuccess: (definition) =>
                  loader
                    .loadAndRegister({
                      boardId,
                      projectId: input.projectId,
                      workspaceRoot: input.workspaceRoot,
                      relativePath,
                    })
                    .pipe(
                      Effect.matchEffect({
                        onFailure: (cause) =>
                          Effect.succeed(
                            makeEntry({
                              boardId,
                              name: definition.name,
                              relativePath,
                              error: errorMessage(cause),
                            }),
                          ),
                        onSuccess: () =>
                          Effect.succeed(
                            makeEntry({
                              boardId,
                              name: definition.name,
                              relativePath,
                              error: null,
                            }),
                          ),
                      }),
                    ),
              }),
            ),
          ),
        );
      }),
    );
  };

  const discover: BoardDiscoveryShape["discover"] = (projectId) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* resolver
        .resolve(projectId)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to resolve workflow project root")));
      const boardsDir = path.join(workspaceRoot, ".t3/boards");
      const exists = yield* fileSystem
        .exists(boardsDir)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to check workflow boards directory")));
      const fileNames = exists
        ? yield* fileSystem
            .readDirectory(boardsDir)
            .pipe(Effect.mapError(toWorkflowRpcError("Failed to list workflow boards directory")))
        : [];
      const boardFileNames = fileNames.filter(isJsonBoardFile).sort();
      const discoveredEntries = yield* Effect.forEach(boardFileNames, (fileName) =>
        discoverFile({ projectId, workspaceRoot, fileName }),
      );
      const entries = discoveredEntries.filter((entry): entry is BoardListEntry => entry !== null);

      const presentBoardIds = new Set(entries.map((entry) => entry.boardId as string));
      const presentFilePaths = new Set(boardFileNames.map((fileName) => `.t3/boards/${fileName}`));
      const cachedEntries = (yield* Ref.get(cache)).get(projectId as string) ?? [];
      const persistedBoards = yield* readModel
        .listBoardsForProject(projectId)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to list persisted workflow boards")));
      const removedCandidates = new Map<string, RemovedBoardCandidate>();

      for (const board of persistedBoards) {
        if (!presentFilePaths.has(board.filePath)) {
          removedCandidates.set(board.boardId as string, {
            boardId: board.boardId as BoardId,
            filePath: board.filePath,
          });
        }
      }

      for (const entry of cachedEntries) {
        if (!presentBoardIds.has(entry.boardId as string)) {
          removedCandidates.set(entry.boardId as string, {
            boardId: entry.boardId,
            filePath: entry.filePath,
          });
        }
      }

      yield* Effect.forEach(
        removedCandidates.values(),
        (candidate) =>
          saveLocks
            .withSaveLock(
              candidate.boardId,
              Effect.gen(function* () {
                const stillExists = yield* fileSystem
                  .exists(path.join(workspaceRoot, candidate.filePath))
                  .pipe(
                    Effect.mapError(
                      toWorkflowRpcError(`Failed to check workflow board ${candidate.filePath}`),
                    ),
                  );
                if (stillExists) {
                  return;
                }

                yield* deleteWorkflowBoardOwnedState(
                  {
                    boardRegistry: registry,
                    engine,
                    eventStore,
                    readModel,
                    versionStore,
                    sql,
                    ...(Option.isSome(worktreeJanitor)
                      ? { worktreeJanitor: worktreeJanitor.value }
                      : {}),
                    ...(Option.isSome(threadJanitor) ? { threadJanitor: threadJanitor.value } : {}),
                    ...(Option.isSome(webhook) ? { webhook: webhook.value } : {}),
                    ...(Option.isSome(agentSessions) ? { agentSessions: agentSessions.value } : {}),
                    ...(Option.isSome(providerService) ? { provider: providerService.value } : {}),
                  },
                  candidate.boardId,
                );
              }),
            )
            .pipe(Effect.mapError(toWorkflowRpcError("Failed to unregister workflow board"))),
        { discard: true },
      );

      yield* Ref.update(cache, (current) => new Map(current).set(projectId as string, entries));
      return entries;
    });

  const list: BoardDiscoveryShape["list"] = (projectId) =>
    Ref.get(cache).pipe(
      Effect.flatMap((current) => {
        const cached = current.get(projectId as string);
        return cached === undefined ? discover(projectId) : Effect.succeed(cached);
      }),
    );

  return { discover, list } satisfies BoardDiscoveryShape;
});

export const BoardDiscoveryLive = Layer.effect(BoardDiscovery, make);
