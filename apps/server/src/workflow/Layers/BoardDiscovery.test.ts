import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { BoardId, type ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { BoardDiscovery } from "../Services/BoardDiscovery.ts";
import { ProjectWorkspaceResolver } from "../Services/ProjectWorkspaceResolver.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { WorkflowBoardVersionStore } from "../Services/WorkflowBoardVersionStore.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowProviderInstancePort } from "../Services/WorkflowFileLoader.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { defaultBoardDefinition } from "../defaultBoard.ts";
import { encodeWorkflowDefinitionJson } from "../workflowFile.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { BoardDiscoveryLive } from "./BoardDiscovery.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowBoardVersionStoreLive } from "./WorkflowBoardVersionStore.ts";
import { WorkflowEventStoreLive } from "./WorkflowEventStore.ts";
import { WorkflowFileLoaderLive, WorkflowFilePortLive } from "./WorkflowFileLoader.ts";
import { WorkflowReadModelLive } from "./WorkflowReadModel.ts";

const projectId = "project-discovery" as ProjectId;

const boardFile = (name: string) =>
  encodeWorkflowDefinitionJson(
    defaultBoardDefinition({
      name,
      agent: { instance: "codex_main", model: "gpt-5.5" },
    }),
  );

const workflowEngineStub = Layer.succeed(WorkflowEngine, {
  createTicket: () => Effect.die("unused"),
  editTicket: () => Effect.void,
  moveTicket: () => Effect.die("unused"),
  createTicketAndEnterUnlocked: () => Effect.die("unused"),
  closeTicketFromSourceUnlocked: () => Effect.die("unused"),
  reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
  cancellableProviderTurnsForTicket: () => Effect.die("unused"),
  supersedeProviderWorkForTicket: () => Effect.die("unused"),
  terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
  stopAgentSessionsForTicket: () => Effect.die("unused"),
  editTicketFieldsUnlocked: () => Effect.die("unused"),
  withBoardAdmissionLock: (_boardId, effect) => effect,
  runLane: () => Effect.die("unused"),
  ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
  resolveApproval: () => Effect.die("unused"),
  answerTicketStep: () => Effect.die("unused"),
  postTicketMessage: () => Effect.die("unused"),
  editTicketMessage: () => Effect.die("unused"),
  cancelStep: () => Effect.die("unused"),
  cancelBoardPipelines: () => Effect.void,
  cancelTicketPipelines: () => Effect.void,
  recoverBoardWip: () => Effect.void,
  completeRecoveredStep: () => Effect.die("unused"),
});

it.layer(NodeServices.layer)("BoardDiscovery", (it) => {
  it.effect(
    "discovers boards, reports invalid files, and retains history across absent files",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-board-discovery-",
          });
          const boardsDir = path.join(workspaceRoot, ".t3/boards");
          yield* fs.makeDirectory(boardsDir, { recursive: true });
          yield* fs.writeFileString(path.join(boardsDir, "alpha.json"), boardFile("Alpha"));
          yield* fs.writeFileString(path.join(boardsDir, "beta.json"), boardFile("Beta"));
          yield* fs.writeFileString(path.join(boardsDir, "broken.json"), "{");

          const layer = BoardDiscoveryLive.pipe(
            Layer.provideMerge(
              Layer.succeed(ProjectWorkspaceResolver, {
                resolve: () => Effect.succeed(workspaceRoot),
              }),
            ),
            Layer.provideMerge(WorkflowFileLoaderLive),
            Layer.provideMerge(WorkflowFilePortLive),
            Layer.provideMerge(
              Layer.succeed(WorkflowProviderInstancePort, {
                providerInstanceExists: (instanceId) => Effect.succeed(instanceId === "codex_main"),
                providerInstanceSupportsResume: (instanceId) =>
                  Effect.succeed(instanceId === "codex_main"),
              }),
            ),
            Layer.provideMerge(workflowEngineStub),
            Layer.provideMerge(WorkflowEventStoreLive),
            Layer.provideMerge(WorkflowReadModelLive),
            Layer.provideMerge(BoardRegistryLive),
            Layer.provideMerge(WorkflowBoardVersionStoreLive),
            Layer.provideMerge(WorkflowBoardSaveLocksLive),
            Layer.provideMerge(MigrationsLive),
            Layer.provideMerge(SqlitePersistenceMemory),
          );

          yield* Effect.gen(function* () {
            const discovery = yield* BoardDiscovery;
            const read = yield* WorkflowReadModel;
            const registry = yield* BoardRegistry;
            const versions = yield* WorkflowBoardVersionStore;
            const sql = yield* SqlClient.SqlClient;
            const alphaBoardId = `${projectId}__alpha` as never;

            const entries = yield* discovery.discover(projectId);
            assert.equal(entries.length, 3);
            assert.isTrue(
              entries.some(
                (entry) =>
                  entry.boardId === `${projectId}__alpha` &&
                  entry.filePath === ".t3/boards/alpha.json" &&
                  entry.error === null,
              ),
            );
            assert.isTrue(
              entries.some(
                (entry) => entry.boardId === `${projectId}__broken` && entry.error !== null,
              ),
            );
            assert.deepEqual(yield* versions.list(alphaBoardId), []);

            const boards = yield* read.listBoardsForProject(projectId);
            assert.deepEqual(
              boards.map((board) => board.boardId),
              [`${projectId}__alpha`, `${projectId}__beta`],
            );

            yield* versions.record({
              boardId: alphaBoardId,
              versionHash: "hash-alpha",
              contentJson: '{"name":"Alpha"}\n',
              source: "import",
            });
            yield* sql`
              INSERT INTO projection_ticket (
                ticket_id,
                board_id,
                title,
                current_lane_key,
                status,
                created_at,
                updated_at
              )
              VALUES (
                'ticket-alpha-stale',
                ${alphaBoardId},
                'Stale alpha ticket',
                'backlog',
                'idle',
                '2026-06-07T00:00:00.000Z',
                '2026-06-07T00:00:00.000Z'
              )
            `;
            yield* sql`
              INSERT INTO workflow_events (
                event_id,
                ticket_id,
                stream_version,
                event_type,
                occurred_at,
                payload_json
              )
              VALUES (
                'evt-alpha-stale',
                'ticket-alpha-stale',
                0,
                'TicketCreated',
                '2026-06-07T00:00:00.000Z',
                ${`{"boardId":"${alphaBoardId}","title":"Stale alpha ticket","laneKey":"backlog"}`}
              )
            `;
            yield* sql`
              INSERT INTO workflow_dispatch_outbox (
                dispatch_id,
                ticket_id,
                step_run_id,
                thread_id,
                provider_instance,
                model,
                instruction,
                worktree_path,
                status,
                created_at
              )
              VALUES (
                'dispatch-alpha-stale',
                'ticket-alpha-stale',
                'step-alpha-stale',
                'thread-alpha-stale',
                'codex',
                'gpt-5.5',
                'stale dispatch',
                '/tmp/alpha-stale',
                'pending',
                '2026-06-07T00:00:00.000Z'
              )
            `;
            yield* sql`
              INSERT INTO workflow_setup_run (
                setup_run_id,
                ticket_id,
                worktree_ref,
                status,
                started_at
              )
              VALUES (
                'setup-alpha-stale',
                'ticket-alpha-stale',
                'worktree-alpha-stale',
                'running',
                '2026-06-07T00:00:00.000Z'
              )
            `;
            yield* fs.writeFileString(path.join(boardsDir, "alpha.json"), "{");
            const afterInvalid = yield* discovery.discover(projectId);
            assert.isTrue(
              afterInvalid.some(
                (entry) => entry.boardId === `${projectId}__alpha` && entry.error !== null,
              ),
            );
            assert.isNotNull(yield* registry.getDefinition(`${projectId}__alpha` as never));
            assert.deepEqual(
              (yield* versions.list(alphaBoardId)).map((version) => version.versionHash),
              ["hash-alpha"],
            );
            assert.isTrue(
              (yield* read.listBoardsForProject(projectId)).some(
                (board) => board.boardId === `${projectId}__alpha`,
              ),
            );

            yield* fs.remove(path.join(boardsDir, "alpha.json"));
            const afterAbsent = yield* discovery.discover(projectId);
            assert.isFalse(afterAbsent.some((entry) => entry.boardId === `${projectId}__alpha`));
            assert.isNull(yield* registry.getDefinition(`${projectId}__alpha` as never));
            assert.deepEqual(
              (yield* versions.list(alphaBoardId)).map((version) => version.versionHash),
              [],
            );
            assert.deepEqual(
              (yield* read.listBoardsForProject(projectId)).map((board) => board.boardId),
              [`${projectId}__beta`],
            );
            const staleRows = yield* sql<{ readonly tableName: string; readonly count: number }>`
              SELECT 'projection_ticket' AS tableName, COUNT(*) AS count
              FROM projection_ticket
              WHERE board_id = ${alphaBoardId}
              UNION ALL
              SELECT 'workflow_events' AS tableName, COUNT(*) AS count
              FROM workflow_events
              WHERE ticket_id = 'ticket-alpha-stale'
              UNION ALL
              SELECT 'workflow_dispatch_outbox' AS tableName, COUNT(*) AS count
              FROM workflow_dispatch_outbox
              WHERE ticket_id = 'ticket-alpha-stale'
              UNION ALL
              SELECT 'workflow_setup_run' AS tableName, COUNT(*) AS count
              FROM workflow_setup_run
              WHERE ticket_id = 'ticket-alpha-stale'
            `;
            assert.deepEqual(
              staleRows.map((row) => [row.tableName, row.count]),
              [
                ["projection_ticket", 0],
                ["workflow_events", 0],
                ["workflow_dispatch_outbox", 0],
                ["workflow_setup_run", 0],
              ],
            );

            yield* fs.writeFileString(path.join(boardsDir, "alpha.json"), boardFile("Alpha"));
            const afterReappear = yield* discovery.discover(projectId);
            assert.isTrue(afterReappear.some((entry) => entry.boardId === `${projectId}__alpha`));
            assert.deepEqual(
              (yield* versions.list(alphaBoardId)).map((version) => version.versionHash),
              [],
            );
            assert.deepEqual(yield* read.listTickets(alphaBoardId), []);
          }).pipe(Effect.provide(layer));
        }),
      ),
  );

  it.effect("does not register a board that is deleted after directory listing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-board-discovery-race-",
        });
        const boardsDir = path.join(workspaceRoot, ".t3/boards");
        const alphaPath = path.join(boardsDir, "alpha.json");
        const alphaBoardId = BoardId.make(`${projectId}__alpha`);
        const staleAlpha = boardFile("Alpha");
        const listed = yield* Deferred.make<ReadonlyArray<string>>();
        const deleted = yield* Deferred.make<void>();
        yield* fs.makeDirectory(boardsDir, { recursive: true });
        yield* fs.writeFileString(alphaPath, staleAlpha);

        const staleFileSystemLayer = Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          readDirectory: (target, options) =>
            target === boardsDir
              ? Effect.gen(function* () {
                  const entries = yield* fs.readDirectory(target, options);
                  yield* Deferred.succeed(listed, entries).pipe(Effect.ignore);
                  yield* Deferred.await(deleted);
                  return entries;
                })
              : fs.readDirectory(target, options),
          readFileString: (target, encoding) =>
            target === alphaPath ? Effect.succeed(staleAlpha) : fs.readFileString(target, encoding),
        } satisfies FileSystem.FileSystem);

        const layer = BoardDiscoveryLive.pipe(
          Layer.provideMerge(
            Layer.succeed(ProjectWorkspaceResolver, {
              resolve: () => Effect.succeed(workspaceRoot),
            }),
          ),
          Layer.provideMerge(WorkflowFileLoaderLive),
          Layer.provideMerge(WorkflowFilePortLive),
          Layer.provideMerge(
            Layer.succeed(WorkflowProviderInstancePort, {
              providerInstanceExists: (instanceId) => Effect.succeed(instanceId === "codex_main"),
              providerInstanceSupportsResume: (instanceId) =>
                Effect.succeed(instanceId === "codex_main"),
            }),
          ),
          Layer.provideMerge(workflowEngineStub),
          Layer.provideMerge(WorkflowEventStoreLive),
          Layer.provideMerge(WorkflowReadModelLive),
          Layer.provideMerge(BoardRegistryLive),
          Layer.provideMerge(WorkflowBoardVersionStoreLive),
          Layer.provideMerge(WorkflowBoardSaveLocksLive),
          Layer.provideMerge(MigrationsLive),
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provideMerge(staleFileSystemLayer),
        );

        yield* Effect.gen(function* () {
          const discovery = yield* BoardDiscovery;
          const registry = yield* BoardRegistry;
          const read = yield* WorkflowReadModel;
          const saveLocks = yield* WorkflowBoardSaveLocks;

          yield* registry.register(
            alphaBoardId,
            defaultBoardDefinition({
              name: "Alpha",
              agent: { instance: "codex_main", model: "gpt-5.5" },
            }),
          );
          yield* read.registerBoard({
            boardId: alphaBoardId,
            projectId,
            name: "Alpha",
            workflowFilePath: ".t3/boards/alpha.json",
            workflowVersionHash: "hash-alpha-before-delete",
            maxConcurrentTickets: 3,
          });

          const discoverFiber = yield* Effect.forkChild(discovery.discover(projectId));
          assert.deepEqual(yield* Deferred.await(listed), ["alpha.json"]);

          yield* saveLocks.withSaveLock(
            alphaBoardId,
            Effect.gen(function* () {
              yield* fs.remove(alphaPath);
              yield* registry.unregister(alphaBoardId);
              yield* read.deleteBoard(alphaBoardId);
            }),
          );
          yield* Deferred.succeed(deleted, undefined);

          const entries = yield* Fiber.join(discoverFiber);
          assert.isFalse(entries.some((entry) => entry.boardId === alphaBoardId));
          assert.isNull(yield* registry.getDefinition(alphaBoardId));
          assert.isNull(yield* read.getBoard(alphaBoardId));
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect("cascades a persisted board whose file is missing without a cache entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-board-discovery-persisted-missing-",
        });
        const boardsDir = path.join(workspaceRoot, ".t3/boards");
        const boardId = BoardId.make(`${projectId}__persisted-missing`);
        yield* fs.makeDirectory(boardsDir, { recursive: true });

        const layer = BoardDiscoveryLive.pipe(
          Layer.provideMerge(
            Layer.succeed(ProjectWorkspaceResolver, {
              resolve: () => Effect.succeed(workspaceRoot),
            }),
          ),
          Layer.provideMerge(WorkflowFileLoaderLive),
          Layer.provideMerge(WorkflowFilePortLive),
          Layer.provideMerge(
            Layer.succeed(WorkflowProviderInstancePort, {
              providerInstanceExists: (instanceId) => Effect.succeed(instanceId === "codex_main"),
              providerInstanceSupportsResume: (instanceId) =>
                Effect.succeed(instanceId === "codex_main"),
            }),
          ),
          Layer.provideMerge(workflowEngineStub),
          Layer.provideMerge(WorkflowEventStoreLive),
          Layer.provideMerge(WorkflowReadModelLive),
          Layer.provideMerge(BoardRegistryLive),
          Layer.provideMerge(WorkflowBoardVersionStoreLive),
          Layer.provideMerge(WorkflowBoardSaveLocksLive),
          Layer.provideMerge(MigrationsLive),
          Layer.provideMerge(SqlitePersistenceMemory),
        );

        yield* Effect.gen(function* () {
          const discovery = yield* BoardDiscovery;
          const registry = yield* BoardRegistry;
          const read = yield* WorkflowReadModel;
          const versions = yield* WorkflowBoardVersionStore;
          const sql = yield* SqlClient.SqlClient;
          const now = "2026-06-07T00:00:00.000Z";

          yield* registry.register(
            boardId,
            defaultBoardDefinition({
              name: "Persisted missing",
              agent: { instance: "codex_main", model: "gpt-5.5" },
            }),
          );
          yield* read.registerBoard({
            boardId,
            projectId,
            name: "Persisted missing",
            workflowFilePath: ".t3/boards/persisted-missing.json",
            workflowVersionHash: "hash-persisted-missing",
            maxConcurrentTickets: 1,
          });
          yield* versions.record({
            boardId,
            versionHash: "hash-persisted-missing",
            contentJson: '{"name":"Persisted missing"}\n',
            source: "import",
          });
          yield* sql`
            INSERT INTO projection_ticket (
              ticket_id,
              board_id,
              title,
              current_lane_key,
              status,
              created_at,
              updated_at
            )
            VALUES (
              'ticket-persisted-missing',
              ${boardId},
              'Persisted missing ticket',
              'backlog',
              'idle',
              ${now},
              ${now}
            )
          `;
          yield* sql`
            INSERT INTO workflow_events (
              event_id,
              ticket_id,
              stream_version,
              event_type,
              occurred_at,
              payload_json
            )
            VALUES (
              'evt-persisted-missing',
              'ticket-persisted-missing',
              0,
              'TicketCreated',
              ${now},
              ${`{"boardId":"${boardId}","title":"Persisted missing ticket","laneKey":"backlog"}`}
            )
          `;
          yield* sql`
            INSERT INTO workflow_dispatch_outbox (
              dispatch_id,
              ticket_id,
              step_run_id,
              thread_id,
              provider_instance,
              model,
              instruction,
              worktree_path,
              status,
              created_at
            )
            VALUES (
              'dispatch-persisted-missing',
              'ticket-persisted-missing',
              'step-persisted-missing',
              'thread-persisted-missing',
              'codex',
              'gpt-5.5',
              'stale persisted dispatch',
              '/tmp/persisted-missing',
              'pending',
              ${now}
            )
          `;

          const entries = yield* discovery.discover(projectId).pipe(Effect.timeout("1 second"));

          assert.isFalse(entries.some((entry) => entry.boardId === boardId));
          assert.isNull(yield* registry.getDefinition(boardId));
          assert.isNull(yield* read.getBoard(boardId));
          assert.deepEqual(yield* versions.list(boardId), []);
          const staleRows = yield* sql<{ readonly tableName: string; readonly count: number }>`
            SELECT 'projection_ticket' AS tableName, COUNT(*) AS count
            FROM projection_ticket
            WHERE board_id = ${boardId}
            UNION ALL
            SELECT 'workflow_events' AS tableName, COUNT(*) AS count
            FROM workflow_events
            WHERE ticket_id = 'ticket-persisted-missing'
            UNION ALL
            SELECT 'workflow_dispatch_outbox' AS tableName, COUNT(*) AS count
            FROM workflow_dispatch_outbox
            WHERE ticket_id = 'ticket-persisted-missing'
          `;
          assert.deepEqual(
            staleRows.map((row) => [row.tableName, row.count]),
            [
              ["projection_ticket", 0],
              ["workflow_events", 0],
              ["workflow_dispatch_outbox", 0],
            ],
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
});
