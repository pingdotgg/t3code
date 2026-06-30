import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type BoardListEntry,
  BoardId,
  LaneKey,
  type ProjectId,
  StepKey,
  StepRunId,
  TicketId,
  WORKFLOW_WS_METHODS,
  WorkflowDefinition,
  type WorkflowDefinition as WorkflowDefinitionType,
  type WorkflowDefinitionEncoded,
  WorkflowRpcError,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import {
  proposeBoardImprovement,
  listBoardProposals,
  getBoardProposal,
  resolveBoardProposal,
  revertBoardProposal,
  validateAndCreateBoard,
  createWorkflowBoard,
  generateWorkflowDraft,
  workflowRpcHandlers,
} from "./WorkflowRpcHandlers.ts";
import { BOARD_TEMPLATES } from "../boardTemplates.ts";
import { makeWorkflowBoardSaveLocks } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowBoardVersionStoreLive } from "./WorkflowBoardVersionStore.ts";
import { defaultBoardDefinition } from "../defaultBoard.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import type { ProjectScriptTrustShape } from "../Services/ProjectScriptTrust.ts";
import type { WorkSourceConnectionStoreShape } from "../Services/WorkSourceConnectionStore.ts";
import { WorkSourceAuthError } from "../Services/WorkSourceProvider.ts";
import type {
  WorkflowBoardVersionRecordInput,
  WorkflowBoardVersionSource,
  WorkflowBoardVersionStoreShape,
} from "../Services/WorkflowBoardVersionStore.ts";
import { WorkflowBoardVersionStore } from "../Services/WorkflowBoardVersionStore.ts";
import type { WorkflowReadModelShape } from "../Services/WorkflowReadModel.ts";
import type { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import {
  encodeWorkflowDefinitionJson,
  lintWorkflowDefinition,
  type LintError,
} from "../workflowFile.ts";
import { MAX_PREDICATE_DEPTH } from "../jsonLogicRule.ts";

const noopProjectScriptTrust = {
  isTrusted: () => Effect.succeed(false),
  setTrusted: () => Effect.void,
} satisfies ProjectScriptTrustShape;

const noopConnectionStore = {
  getToken: (connectionRef: string, _expectedProvider) =>
    Effect.fail(new WorkSourceAuthError({ connectionRef })),
  getConnectionAuth: (connectionRef: string, _expectedProvider) =>
    Effect.fail(new WorkSourceAuthError({ connectionRef })),
  create: () => Effect.die("noopConnectionStore.create not implemented"),
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
} satisfies WorkSourceConnectionStoreShape;

const noopVersionStore = {
  record: () => Effect.void,
  list: () => Effect.succeed([]),
  get: () => Effect.succeed(null),
  deleteForBoard: () => Effect.void,
} satisfies WorkflowBoardVersionStoreShape;

const noopReadModel = {
  registerBoard: () => Effect.void,
  getBoard: () => Effect.succeed(null),
  deleteBoard: () => Effect.void,
  deleteBoardTicketState: () => Effect.void,
  deleteTicketState: () => Effect.void,
  listBoardsForProject: () => Effect.succeed([]),
  listTickets: () => Effect.succeed([]),
  countAdmittedInLane: () => Effect.succeed(0),
  oldestQueuedForLane: () => Effect.succeed(null),
  getTicketDetail: () => Effect.succeed(null),
  listTicketMessages: () => Effect.succeed([]),
  listTicketDiscussion: () => Effect.succeed([]),
  listTicketRouteDecisions: () => Effect.succeed([]),
  listReleasableDependents: () => Effect.succeed([]),
  listDependentTicketIds: () => Effect.succeed([]),
  getBoardDigest: () =>
    Effect.succeed({
      windowHours: 24,
      createdCount: 0,
      shippedCount: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      needsAttention: [],
    }),
  getBoardMetrics: () =>
    Effect.succeed({
      windowDays: 7,
      generatedAt: "2026-06-07T00:00:00.000Z",
      throughput: { created: 0, shipped: 0 },
      cycleTime: { count: 0, p50Ms: 0, p90Ms: 0, avgMs: 0 },
      wipByLane: [],
      statusBreakdown: {},
      attention: { blocked: 0, waitingOnUser: 0, oldest: [] },
      routeOutcomes: [],
      manualMoveCount: 0,
      stepStats: [],
    }),
  listNeedsAttentionTickets: () => Effect.succeed([]),
  countLanePipelineRuns: () => Effect.succeed(1),
  listStepRunsForPipeline: () => Effect.succeed([]),
  getTicketPrState: () => Effect.succeed(null),
  recordBoardProposal: () => Effect.void,
  listBoardProposals: () => Effect.succeed([]),
  getBoardProposal: () => Effect.succeed(null),
  listLiveOccupiedLanes: () => Effect.succeed([]),
  resolveBoardProposalStatus: () => Effect.succeed(1),
  listWorkSourceMappingsForBoard: () => Effect.succeed([]),
} satisfies WorkflowReadModelShape;

const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const decodeWorkflowDefinitionJson = Schema.decodeEffect(Schema.fromJsonString(WorkflowDefinition));
const encodeWorkflowDefinition = Schema.encodeSync(WorkflowDefinition);
const sha256Hex = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

const versionRoundTripLayer = it.layer(
  WorkflowBoardVersionStoreLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const invokeWorkflowHandler = <A>(
  handlers: ReturnType<typeof workflowRpcHandlers>,
  method: string,
  input: unknown,
): Effect.Effect<A, WorkflowRpcError> => {
  const handler = (
    handlers as unknown as Record<string, (input: unknown) => Effect.Effect<A, WorkflowRpcError>>
  )[method];
  return handler
    ? handler(input)
    : Effect.fail(new WorkflowRpcError({ message: `${method} handler is not registered` }));
};

it.effect("workflowRpcHandlers maps createTicket and subscribeBoard", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("board-1");
    const backlog = LaneKey.make("backlog");
    const review = LaneKey.make("review");
    const definition = {
      name: "Delivery",
      lanes: [
        { key: backlog, name: "Backlog", entry: "manual" },
        {
          key: review,
          name: "Review",
          entry: "manual",
          wipLimit: 2,
          pipeline: [{ key: StepKey.make("approve"), type: "approval", prompt: "Approve?" }],
        },
      ],
    } satisfies WorkflowDefinitionType;
    let editedTicket: unknown = null;
    let answeredStep: unknown = null;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.succeed(TicketId.make("ticket-created")),
        editTicket: (input) =>
          Effect.sync(() => {
            editedTicket = input;
          }),
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: (input) =>
          Effect.sync(() => {
            answeredStep = input;
          }),
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId: "project-1",
            name: "Delivery",
            workflowFilePath: ".t3/boards/delivery.json",
            workflowVersionHash: "hash",
            maxConcurrentTickets: 2,
          }),
        listTickets: () =>
          Effect.succeed([
            {
              ticketId: "ticket-1",
              boardId,
              title: "Existing",
              description: null,
              currentLaneKey: "backlog",
              currentLaneEntryToken: null,
              queuedAt: "2026-06-07T00:00:00.000Z",
              totalTokens: null,
              totalDurationMs: null,
              status: "idle",
            },
          ]),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.succeed(boardId),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/project"),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const created = yield* handlers[WORKFLOW_WS_METHODS.createTicket]({
      boardId,
      title: "New ticket",
      initialLane: backlog,
    });
    yield* handlers[WORKFLOW_WS_METHODS.editTicket]({
      ticketId: TicketId.make("ticket-1"),
      title: "Updated",
      description: "",
    });
    yield* handlers[WORKFLOW_WS_METHODS.answerTicketStep]({
      stepRunId: StepRunId.make("step-1"),
      text: "Use sandbox.",
      attachments: [],
    });
    const streamItems = Array.from(
      yield* handlers[WORKFLOW_WS_METHODS.subscribeBoard]({ boardId }).pipe(
        Stream.take(1),
        Stream.runCollect,
      ),
    );

    assert.deepEqual(created, { ticketId: "ticket-created" });
    assert.deepEqual(editedTicket, {
      ticketId: TicketId.make("ticket-1"),
      title: "Updated",
      description: "",
    });
    assert.deepEqual(answeredStep, {
      stepRunId: StepRunId.make("step-1"),
      text: "Use sandbox.",
      attachments: [],
    });
    assert.equal(streamItems[0]?.kind, "snapshot");
    if (streamItems[0]?.kind === "snapshot") {
      assert.equal(streamItems[0].snapshot.board.name, "Delivery");
      assert.equal(streamItems[0].snapshot.board.lanes[0]?.pipelineStepCount, 0);
      assert.equal(streamItems[0].snapshot.board.lanes[1]?.pipelineStepCount, 1);
      assert.equal(streamItems[0].snapshot.board.lanes[1]?.wipLimit, 2);
      assert.equal(streamItems[0].snapshot.tickets[0]?.title, "Existing");
      assert.equal(streamItems[0].snapshot.tickets[0]?.queuedAt, "2026-06-07T00:00:00.000Z");
    }
  }),
);

it.effect("workflowRpcHandlers lists and creates boards without a client path", () =>
  Effect.gen(function* () {
    const projectId = "project-rpc" as ProjectId;
    const projectRoot = "/tmp/project-rpc-root";
    const rows = new Map<
      string,
      {
        readonly boardId: string;
        readonly projectId: string;
        readonly name: string;
        readonly workflowFilePath: string;
        readonly workflowVersionHash: string;
        readonly maxConcurrentTickets: number;
      }
    >();
    const definitions = new Map<string, WorkflowDefinitionType>();
    const entries: BoardListEntry[] = [];
    const writes: Array<{
      readonly projectRoot: string;
      readonly relativePath: string;
      readonly contents: string;
    }> = [];
    const versionRecords: WorkflowBoardVersionRecordInput[] = [];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: (boardId) => Effect.succeed(rows.get(boardId as string) ?? null),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: (boardId) => Effect.succeed(definitions.get(boardId as string) ?? null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: (input) =>
          Effect.sync(() => {
            const content = writes.find(
              (write) => write.relativePath === input.relativePath,
            )?.contents;
            const definition = defaultBoardDefinition({
              name: input.relativePath.includes("-2") ? "Workflow Board" : "Workflow Board",
              agent: { instance: "codex_main", model: "gpt-5.5" },
            });
            rows.set(input.boardId as string, {
              boardId: input.boardId,
              projectId: input.projectId,
              name: definition.name,
              workflowFilePath: input.relativePath,
              workflowVersionHash: sha256Hex(content ?? ""),
              maxConcurrentTickets: 3,
            });
            definitions.set(input.boardId as string, definition);
            entries.push({
              boardId: input.boardId,
              name: definition.name,
              filePath: input.relativePath,
              error: null,
            });
            return input.boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) =>
          Effect.sync(() => {
            versionRecords.push(input);
          }),
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed(entries),
        list: () => Effect.succeed(entries),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(projectRoot),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("writeFile must not be used"),
        createFileExclusive: (input: Parameters<WorkspaceFileSystem["Service"]["createFileExclusive"]>[0]) =>
          Effect.sync(() => {
            writes.push(input);
            return { relativePath: input.relativePath };
          }),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const overlongCreate = yield* Effect.exit(
      handlers[WORKFLOW_WS_METHODS.createBoard]({
        projectId,
        name: "A".repeat(129),
        agent: { instance: "codex_main", model: "gpt-5.5" },
      }),
    );
    assert.strictEqual(overlongCreate._tag, "Failure");
    assert.deepEqual(writes, []);

    assert.deepEqual(yield* handlers[WORKFLOW_WS_METHODS.listBoards]({ projectId }), []);

    const first = yield* handlers[WORKFLOW_WS_METHODS.createBoard]({
      projectId,
      name: "Workflow Board",
      agent: { instance: "codex_main", model: "gpt-5.5" },
    });
    const second = yield* handlers[WORKFLOW_WS_METHODS.createBoard]({
      projectId,
      name: "Workflow Board",
      agent: { instance: "codex_main", model: "gpt-5.5" },
    });

    assert.equal(first.boardId, `${projectId}__workflow-board`);
    assert.equal(first.snapshot.projectId, projectId);
    assert.equal(second.boardId, `${projectId}__workflow-board-2`);
    assert.deepEqual(
      writes.map((write) => ({
        projectRoot: write.projectRoot,
        relativePath: write.relativePath,
      })),
      [
        { projectRoot, relativePath: ".t3/boards/workflow-board.json" },
        { projectRoot, relativePath: ".t3/boards/workflow-board-2.json" },
      ],
    );
    assert.deepEqual(
      versionRecords.map((record) => ({
        boardId: record.boardId,
        versionHash: record.versionHash,
        contentJson: record.contentJson,
        source: record.source,
      })),
      [
        {
          boardId: first.boardId,
          versionHash: sha256Hex(writes[0]!.contents),
          contentJson: writes[0]!.contents,
          source: "create",
        },
        {
          boardId: second.boardId,
          versionHash: sha256Hex(writes[1]!.contents),
          contentJson: writes[1]!.contents,
          source: "create",
        },
      ],
    );
    assert.deepEqual(
      (yield* handlers[WORKFLOW_WS_METHODS.listBoards]({ projectId })).map(
        (entry) => entry.boardId,
      ),
      [`${projectId}__workflow-board`, `${projectId}__workflow-board-2`],
    );
  }),
);

it.effect(
  "workflowRpcHandlers deletes the board file before clearing registration and history",
  () =>
    Effect.gen(function* () {
      const boardId = BoardId.make("project-rpc__delete-me");
      const projectId = "project-rpc" as ProjectId;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-delete-board-",
      });
      const boardFilePath = path.join(workspaceRoot, ".t3/boards/delete-me.json");
      yield* fileSystem.makeDirectory(path.join(workspaceRoot, ".t3/boards"), { recursive: true });
      yield* fileSystem.writeFileString(boardFilePath, "{}\n");
      const operations: string[] = [];
      const fileDeletes: Array<{ readonly cwd: string; readonly relativePath: string }> = [];
      const registryUnregistered: BoardId[] = [];
      const readModelDeleted: BoardId[] = [];
      const versionsDeleted: BoardId[] = [];

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
          stopAgentSessionsForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          editTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: (inputBoardId) =>
            Effect.succeed(
              inputBoardId === boardId
                ? {
                    boardId,
                    projectId,
                    name: "Delete Me",
                    workflowFilePath: ".t3/boards/delete-me.json",
                    workflowVersionHash: "hash-delete-me",
                    maxConcurrentTickets: 3,
                  }
                : null,
            ),
          deleteBoard: (inputBoardId) =>
            Effect.sync(() => {
              operations.push("delete-projection");
              readModelDeleted.push(inputBoardId);
            }),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: (inputBoardId) =>
            Effect.sync(() => {
              operations.push("unregister");
              registryUnregistered.push(inputBoardId);
            }),
          getDefinition: () => Effect.succeed(null),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
          subscribe: () => Effect.succeed(Stream.empty),
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: () => Effect.die("unused"),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: {
          record: () => Effect.void,
          list: () => Effect.succeed([]),
          get: () => Effect.succeed(null),
          deleteForBoard: (inputBoardId) =>
            Effect.sync(() => {
              operations.push("delete-versions");
              versionsDeleted.push(inputBoardId);
            }),
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed(workspaceRoot),
        },
        workspaceFileSystem: {
          readFile: () => Effect.die("unused"),
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.die("unused"),
          writeFile: () => Effect.die("unused"),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: (input: Parameters<WorkspaceFileSystem["Service"]["deleteFile"]>[0]) =>
            Effect.gen(function* () {
              operations.push("delete-file");
              fileDeletes.push(input);
              yield* fileSystem
                .remove(path.join(input.cwd, input.relativePath), { force: true })
                .pipe(Effect.orDie);
            }),
        },
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.deleteBoard, {
        boardId,
        relativePath: "../client-supplied-escape.json",
      });

      const deletedStat = yield* fileSystem
        .stat(boardFilePath)
        .pipe(Effect.orElseSucceed(() => null));
      assert.isNull(deletedStat);
      assert.deepEqual(fileDeletes, [
        { cwd: workspaceRoot, relativePath: ".t3/boards/delete-me.json" },
      ]);
      // The DB cascade (versions → projection) runs inside the deletion
      // transaction; the in-memory unregister happens AFTER it commits, so a
      // rollback leaves the board consistently registered.
      assert.deepEqual(operations, [
        "delete-file",
        "delete-versions",
        "delete-projection",
        "unregister",
      ]);
      assert.deepEqual(registryUnregistered, [boardId]);
      assert.deepEqual(readModelDeleted, [boardId]);
      assert.deepEqual(versionsDeleted, [boardId]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "workflowRpcHandlers cascades board-owned state before deleting the board projection",
  () =>
    Effect.gen(function* () {
      const boardId = BoardId.make("project-rpc__cascade-delete");
      const projectId = "project-rpc" as ProjectId;
      const operations: string[] = [];

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
          stopAgentSessionsForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          editTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: (inputBoardId: BoardId) =>
            Effect.sync(() => {
              assert.equal(inputBoardId, boardId);
              operations.push("cancel-pipelines");
            }),
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: (inputBoardId) =>
            Effect.succeed(
              inputBoardId === boardId
                ? {
                    boardId,
                    projectId,
                    name: "Cascade Delete",
                    workflowFilePath: ".t3/boards/cascade-delete.json",
                    workflowVersionHash: "hash-cascade-delete",
                    maxConcurrentTickets: 3,
                  }
                : null,
            ),
          listTickets: (inputBoardId) =>
            Effect.succeed(
              inputBoardId === boardId
                ? [
                    {
                      ticketId: "ticket-cascade-a",
                      boardId,
                      title: "A",
                      description: null,
                      currentLaneKey: "backlog",
                      currentLaneEntryToken: null,
                      queuedAt: null,
                      totalTokens: null,
                      totalDurationMs: null,
                      status: "idle",
                    },
                    {
                      ticketId: "ticket-cascade-b",
                      boardId,
                      title: "B",
                      description: null,
                      currentLaneKey: "backlog",
                      currentLaneEntryToken: null,
                      queuedAt: null,
                      totalTokens: null,
                      totalDurationMs: null,
                      status: "idle",
                    },
                  ]
                : [],
            ),
          deleteBoardTicketState: (inputBoardId: BoardId) =>
            Effect.sync(() => {
              assert.equal(inputBoardId, boardId);
              operations.push("delete-ticket-state");
            }),
          deleteBoard: (inputBoardId) =>
            Effect.sync(() => {
              assert.equal(inputBoardId, boardId);
              operations.push("delete-board");
            }),
        },
        eventStore: {
          deleteForBoard: (inputBoardId: BoardId) =>
            Effect.sync(() => {
              assert.equal(inputBoardId, boardId);
              operations.push("delete-events");
            }),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: (inputBoardId) =>
            Effect.sync(() => {
              assert.equal(inputBoardId, boardId);
              operations.push("unregister");
            }),
          getDefinition: () => Effect.succeed(null),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
          subscribe: () => Effect.succeed(Stream.empty),
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: () => Effect.die("unused"),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: {
          record: () => Effect.void,
          list: () => Effect.succeed([]),
          get: () => Effect.succeed(null),
          deleteForBoard: (inputBoardId) =>
            Effect.sync(() => {
              assert.equal(inputBoardId, boardId);
              operations.push("delete-versions");
            }),
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed("/workspace/project-rpc"),
        },
        workspaceFileSystem: {
          readFile: () => Effect.die("unused"),
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.die("unused"),
          writeFile: () => Effect.die("unused"),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () =>
            Effect.sync(() => {
              operations.push("delete-file");
            }),
        },
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.deleteBoard, { boardId });

      // The board-owned DB cascade (versions → events → ticket-state → board)
      // runs inside the deletion transaction; the in-memory unregister happens
      // AFTER it commits (so a rollback leaves the board consistently registered).
      assert.deepEqual(operations, [
        "delete-file",
        "cancel-pipelines",
        "delete-versions",
        "delete-events",
        "delete-ticket-state",
        "delete-board",
        "unregister",
      ]);
    }),
);

it.effect("workflowRpcHandlers completes deleteBoard retry after a mid-cascade failure", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-rpc__retry-delete");
    const projectId = "project-rpc" as ProjectId;
    let boardProjectionPresent = true;
    let versionRows = 1;
    let ticketRows = 1;
    let eventRows = 1;
    let outboxRows = 1;
    let setupRows = 1;
    let failProjectionDeleteOnce = true;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: (inputBoardId) =>
          Effect.succeed(
            inputBoardId === boardId && boardProjectionPresent
              ? {
                  boardId,
                  projectId,
                  name: "Retry Delete",
                  workflowFilePath: ".t3/boards/retry-delete.json",
                  workflowVersionHash: "hash-retry-delete",
                  maxConcurrentTickets: 3,
                }
              : null,
          ),
        listTickets: (inputBoardId) =>
          Effect.succeed(
            inputBoardId === boardId && ticketRows > 0
              ? [
                  {
                    ticketId: "ticket-retry-delete",
                    boardId,
                    title: "Retry ticket",
                    description: null,
                    currentLaneKey: "backlog",
                    currentLaneEntryToken: null,
                    queuedAt: null,
                    totalTokens: null,
                    totalDurationMs: null,
                    status: "idle",
                  },
                ]
              : [],
          ),
        deleteBoardTicketState: () =>
          Effect.sync(() => {
            ticketRows = 0;
            outboxRows = 0;
            setupRows = 0;
          }),
        deleteBoard: () =>
          Effect.sync(() => {
            boardProjectionPresent = false;
          }).pipe(
            Effect.andThen(
              failProjectionDeleteOnce
                ? Effect.sync(() => {
                    failProjectionDeleteOnce = false;
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new WorkflowEventStoreError({
                          message: "simulated post-projection failure",
                        }),
                      ),
                    ),
                  )
                : Effect.void,
            ),
          ),
      },
      eventStore: {
        deleteForBoard: () =>
          Effect.sync(() => {
            eventRows = 0;
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: () => Effect.void,
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
        deleteForBoard: () =>
          Effect.sync(() => {
            versionRows = 0;
          }),
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/workspace/project-rpc"),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.void,
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    let firstAttemptFailed = false;
    yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.deleteBoard, {
      boardId,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          firstAttemptFailed = error.message === "Failed to delete workflow board state";
        }),
      ),
    );
    assert.isTrue(firstAttemptFailed);
    assert.isFalse(boardProjectionPresent);
    assert.equal(versionRows, 0);

    versionRows = 1;
    ticketRows = 1;
    eventRows = 1;
    outboxRows = 1;
    setupRows = 1;

    yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.deleteBoard, { boardId });

    assert.deepEqual(
      {
        boardProjectionPresent,
        versionRows,
        ticketRows,
        eventRows,
        outboxRows,
        setupRows,
      },
      {
        boardProjectionPresent: false,
        versionRows: 0,
        ticketRows: 0,
        eventRows: 0,
        outboxRows: 0,
        setupRows: 0,
      },
    );
  }),
);

it.effect("workflowRpcHandlers rejects deleteBoard whose derived path is not a board file", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-rpc__unsafe-delete");
    const sideEffects: string[] = [];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId: "project-rpc",
            name: "Unsafe Delete",
            workflowFilePath: ".t3/boards/../escape.json",
            workflowVersionHash: "hash-unsafe-delete",
            maxConcurrentTickets: 3,
          }),
        deleteBoard: () =>
          Effect.sync(() => {
            sideEffects.push("delete-projection");
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () =>
          Effect.sync(() => {
            sideEffects.push("unregister");
          }),
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: () => Effect.void,
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
        deleteForBoard: () =>
          Effect.sync(() => {
            sideEffects.push("delete-versions");
          }),
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.die("resolve must not run for unsafe delete paths"),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () =>
          Effect.sync(() => {
            sideEffects.push("delete-file");
          }),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const result = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.deleteBoard, { boardId }),
    );

    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.isTrue(result.cause.toString().includes("not a deletable workflow board file"));
    }
    assert.deepEqual(sideEffects, []);
  }),
);

it.effect("workflowRpcHandlers includes route history in ticket detail", () =>
  Effect.gen(function* () {
    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getTicketDetail: () =>
          Effect.succeed({
            ticket: {
              ticketId: "ticket-route-rpc",
              boardId: "board-route-rpc",
              title: "Routed",
              description: null,
              currentLaneKey: "review",
              currentLaneEntryToken: null,
              queuedAt: null,
              totalTokens: null,
              totalDurationMs: null,
              status: "idle",
            },
            steps: [],
            messages: [],
          } as never),
        listTicketRouteDecisions: () =>
          Effect.succeed([
            {
              occurredAt: "2026-06-07T00:00:01.000Z",
              fromLane: "implement",
              toLane: "review",
              source: "lane_transition" as const,
              matchedTransitionIndex: 1,
              eventName: null,
              pipelineResult: "success" as const,
              laneRunCount: 2,
              steps: {
                verdict: { status: "completed", exitCode: 0, verdict: "approve" },
              },
            },
            {
              occurredAt: "2026-06-07T00:00:02.000Z",
              fromLane: null,
              toLane: "implement",
              source: "manual" as const,
              matchedTransitionIndex: null,
              eventName: null,
              pipelineResult: null,
              laneRunCount: null,
              steps: null,
            },
          ]),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/project"),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const detail = yield* handlers[WORKFLOW_WS_METHODS.getTicketDetail]({
      ticketId: TicketId.make("ticket-route-rpc"),
    });

    assert.equal(detail.routeHistory?.length, 2);
    const first = detail.routeHistory?.[0];
    assert.equal(first?.fromLane, "implement");
    assert.equal(first?.source, "lane_transition");
    assert.equal(first?.matchedTransitionIndex, 1);
    assert.equal(first?.pipelineResult, "success");
    assert.equal(first?.laneRunCount, 2);
    assert.deepEqual(first?.steps?.["verdict"], {
      status: "completed",
      exitCode: 0,
      verdict: "approve",
    });
    const second = detail.routeHistory?.[1];
    assert.equal(second?.source, "manual");
    assert.equal(second?.fromLane, undefined);
    assert.equal(second?.matchedTransitionIndex, undefined);
    assert.equal(second?.steps, undefined);
  }),
);

it.effect("workflowRpcHandlers delegates project script trust updates", () =>
  Effect.gen(function* () {
    const projectId = "project-trust-rpc" as ProjectId;
    const updates: Array<{ readonly projectId: ProjectId; readonly trusted: boolean }> = [];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: noopReadModel,
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/project"),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      projectScriptTrust: {
        isTrusted: () => Effect.die("unused"),
        setTrusted: (inputProjectId, trusted) =>
          Effect.sync(() => {
            updates.push({ projectId: inputProjectId, trusted });
          }),
      },
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    yield* handlers[WORKFLOW_WS_METHODS.setProjectScriptTrust]({
      projectId,
      trusted: true,
    });

    assert.deepEqual(updates, [{ projectId, trusted: true }]);
  }),
);

it.effect("workflowRpcHandlers delegates cooperative step cancellation", () =>
  Effect.gen(function* () {
    const stepRunId = StepRunId.make("step-run-cancel-rpc");
    const cancelled: StepRunId[] = [];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        cancelStep: (inputStepRunId) =>
          Effect.sync(() => {
            cancelled.push(inputStepRunId);
          }),
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
      },
      readModel: noopReadModel,
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/project"),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    yield* handlers[WORKFLOW_WS_METHODS.cancelStep]({ stepRunId });

    assert.deepEqual(cancelled, [stepRunId]);
  }),
);

it.effect("workflowRpcHandlers gets and saves encoded board definitions", () =>
  Effect.gen(function* () {
    const projectId = "project-editor-rpc" as ProjectId;
    const boardId = BoardId.make("project-editor-rpc__delivery");
    const workspaceRoot = "/tmp/editor-rpc-project";
    const workflowFilePath = ".t3/boards/delivery.json";
    const originalDefinition = yield* decodeWorkflowDefinition({
      name: "Delivery",
      lanes: [
        {
          key: "run",
          name: "Run",
          entry: "auto",
          pipeline: [{ key: "smoke", type: "script", run: "pnpm test", timeout: "5 minutes" }],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const editedDefinition = yield* decodeWorkflowDefinition({
      name: "Delivery Edited",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual", wipLimit: 2 },
        {
          key: "run",
          name: "Run",
          entry: "auto",
          pipeline: [{ key: "smoke", type: "script", run: "pnpm test", timeout: "5 minutes" }],
          transitions: [{ when: { var: "pipeline.result" }, to: "done" }],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const editedDefinitionEncoded = encodeWorkflowDefinition(editedDefinition);
    const originalRaw = `${encodeWorkflowDefinitionJson(originalDefinition)}\n`;
    const originalHash = sha256Hex(originalRaw);
    let fileContents = originalRaw;
    let registryDefinition = originalDefinition;
    let boardRow = {
      boardId,
      projectId,
      name: originalDefinition.name,
      workflowFilePath,
      workflowVersionHash: originalHash,
      maxConcurrentTickets: 3,
    };
    const writes: Array<{
      readonly cwd: string;
      readonly relativePath: string;
      readonly contents: string;
    }> = [];
    const versionRecords: WorkflowBoardVersionRecordInput[] = [];
    let failNextVersionRecord = false;
    let failedVersionRecordAttempts = 0;
    const lintedDefinitions: WorkflowDefinitionType[] = [];
    const loadedBoards: Array<{
      readonly boardId: BoardId;
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly relativePath: string;
    }> = [];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () => Effect.succeed(boardRow),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(registryDefinition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: (input) =>
          Effect.sync(() => {
            lintedDefinitions.push(input.definition);
            return [];
          }),
        loadAndRegister: (input) =>
          Effect.sync(() => {
            loadedBoards.push(input);
            registryDefinition = editedDefinition;
            boardRow = {
              ...boardRow,
              name: editedDefinition.name,
              workflowVersionHash: sha256Hex(fileContents),
            };
            return input.boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) =>
          failNextVersionRecord
            ? Effect.sync(() => {
                failNextVersionRecord = false;
                failedVersionRecordAttempts += 1;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new WorkflowEventStoreError({ message: "version record unavailable" }),
                  ),
                ),
              )
            : Effect.sync(() => {
                versionRecords.push(input);
              }),
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: (input: Parameters<WorkspaceFileSystem["Service"]["readFileString"]>[0]) =>
          Effect.sync(() => {
            assert.deepEqual(input, { cwd: workspaceRoot, relativePath: workflowFilePath });
            return fileContents;
          }),
        writeFile: (input: Parameters<WorkspaceFileSystem["Service"]["writeFile"]>[0]) =>
          Effect.sync(() => {
            writes.push(input);
            fileContents = input.contents;
            return { relativePath: input.relativePath };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const loaded = yield* invokeWorkflowHandler<{
      readonly definition: unknown;
      readonly versionHash: string;
    }>(handlers, WORKFLOW_WS_METHODS.getBoardDefinition, { boardId });
    assert.equal(loaded.versionHash, originalHash);
    const loadedStep = (
      (loaded.definition as { readonly lanes: readonly unknown[] }).lanes[0] as {
        readonly pipeline?: readonly unknown[];
      }
    ).pipeline?.[0] as { readonly timeout?: unknown } | undefined;
    assert.isDefined(loadedStep);
    assert.isString(loadedStep.timeout);

    const saved = yield* invokeWorkflowHandler<
      | {
          readonly ok: true;
          readonly definition: unknown;
          readonly versionHash: string;
          readonly snapshot: { readonly board: { readonly name: string } };
        }
      | { readonly ok: false; readonly lintErrors: readonly unknown[] }
    >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: editedDefinitionEncoded,
      expectedVersionHash: originalHash,
      workflowFilePath: ".t3/boards/client-supplied.json",
    });

    assert.equal(saved.ok, true);
    if (saved.ok !== true) {
      assert.fail("expected successful save");
    }
    assert.equal(saved.versionHash, sha256Hex(writes[0]!.contents));
    assert.equal(saved.snapshot.board.name, "Delivery Edited");
    assert.equal(lintedDefinitions[0]?.name, "Delivery Edited");
    assert.deepEqual(
      versionRecords.map((record) => ({
        boardId: record.boardId,
        versionHash: record.versionHash,
        contentJson: record.contentJson,
        source: record.source,
      })),
      [
        {
          boardId,
          versionHash: sha256Hex(writes[0]!.contents),
          contentJson: writes[0]!.contents,
          source: "save",
        },
      ],
    );
    assert.deepEqual(
      writes.map((write) => ({
        cwd: write.cwd,
        relativePath: write.relativePath,
      })),
      [{ cwd: workspaceRoot, relativePath: workflowFilePath }],
    );
    const writtenDefinition = yield* decodeWorkflowDefinitionJson(writes[0]!.contents);
    assert.equal(writtenDefinition.name, "Delivery Edited");
    const writtenStep = writtenDefinition.lanes[1]?.pipeline?.[0];
    assert.isDefined(writtenStep);
    assert.equal(writtenStep.type, "script");
    assert.deepEqual(loadedBoards, [
      { boardId, projectId, workspaceRoot, relativePath: workflowFilePath },
    ]);
    const savedStep = (
      (saved.definition as { readonly lanes: readonly unknown[] }).lanes[1] as {
        readonly pipeline?: readonly unknown[];
      }
    ).pipeline?.[0] as { readonly timeout?: unknown } | undefined;
    assert.isDefined(savedStep);
    assert.isString(savedStep.timeout);

    const revertedDefinition = yield* decodeWorkflowDefinition({
      name: "Delivery Reverted",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const reverted = yield* invokeWorkflowHandler<
      | {
          readonly ok: true;
          readonly definition: unknown;
          readonly versionHash: string;
        }
      | { readonly ok: false; readonly lintErrors: readonly unknown[] }
    >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: encodeWorkflowDefinition(revertedDefinition),
      expectedVersionHash: saved.versionHash,
      source: "revert",
    });
    assert.equal(reverted.ok, true);
    if (reverted.ok !== true) {
      assert.fail("expected successful revert save");
    }
    assert.equal(versionRecords.at(-1)?.source, "revert");
    assert.equal(versionRecords.at(-1)?.contentJson, writes.at(-1)?.contents);

    const afterBestEffortFailureDefinition = yield* decodeWorkflowDefinition({
      name: "Delivery After History Failure",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    failNextVersionRecord = true;
    const savedDespiteHistoryFailure = yield* invokeWorkflowHandler<
      | { readonly ok: true; readonly versionHash: string }
      | { readonly ok: false; readonly lintErrors: readonly unknown[] }
    >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: encodeWorkflowDefinition(afterBestEffortFailureDefinition),
      expectedVersionHash: reverted.versionHash,
    });
    assert.equal(savedDespiteHistoryFailure.ok, true);
    assert.equal(failedVersionRecordAttempts, 1);
  }),
);

it.effect(
  "workflowRpcHandlers renames a board display name in file, projection, registry, and history",
  () =>
    Effect.gen(function* () {
      const projectId = "project-rename-rpc" as ProjectId;
      const boardId = BoardId.make("project-rename-rpc__delivery");
      const workspaceRoot = "/tmp/rename-rpc-project";
      const workflowFilePath = ".t3/boards/delivery.json";
      const originalDefinition = yield* decodeWorkflowDefinition({
        name: "Delivery",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      let fileContents = `${encodeWorkflowDefinitionJson(originalDefinition)}\n`;
      let registryDefinition = originalDefinition;
      let boardRow = {
        boardId,
        projectId,
        name: originalDefinition.name,
        workflowFilePath,
        workflowVersionHash: sha256Hex(fileContents),
        maxConcurrentTickets: 3,
      };
      const writes: Array<{
        readonly cwd: string;
        readonly relativePath: string;
        readonly contents: string;
      }> = [];
      const versionRecords: WorkflowBoardVersionRecordInput[] = [];
      const lintedDefinitions: WorkflowDefinitionType[] = [];
      const loadedBoards: Array<{
        readonly boardId: BoardId;
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly relativePath: string;
      }> = [];

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
          stopAgentSessionsForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          editTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: () => Effect.succeed(boardRow),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(registryDefinition),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
          subscribe: () => Effect.succeed(Stream.empty),
        },
        fileLoader: {
          lintDefinition: (input) =>
            Effect.sync(() => {
              lintedDefinitions.push(input.definition);
              return [];
            }),
          loadAndRegister: (input) =>
            Effect.gen(function* () {
              loadedBoards.push(input);
              const definition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
                Effect.orDie,
              );
              registryDefinition = definition;
              boardRow = {
                ...boardRow,
                name: definition.name,
                workflowVersionHash: sha256Hex(fileContents),
              };
              return input.boardId;
            }),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: {
          record: (input) =>
            Effect.sync(() => {
              versionRecords.push(input);
            }),
          list: () => Effect.succeed([]),
          get: () => Effect.succeed(null),
          deleteForBoard: () => Effect.void,
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed(workspaceRoot),
        },
        workspaceFileSystem: {
          readFile: () => Effect.die("unused"),
          listFiles: () => Effect.succeed([]),
          readFileString: (input: Parameters<WorkspaceFileSystem["Service"]["readFileString"]>[0]) =>
            Effect.sync(() => {
              assert.deepEqual(input, { cwd: workspaceRoot, relativePath: workflowFilePath });
              return fileContents;
            }),
          writeFile: (input: Parameters<WorkspaceFileSystem["Service"]["writeFile"]>[0]) =>
            Effect.sync(() => {
              writes.push(input);
              fileContents = input.contents;
              return { relativePath: input.relativePath };
            }),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () => Effect.die("unused"),
        },
        saveLocks: yield* makeWorkflowBoardSaveLocks,
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.renameBoard, {
        boardId,
        name: "Delivery Renamed",
      });

      assert.equal(boardRow.name, "Delivery Renamed");
      assert.equal(registryDefinition.name, "Delivery Renamed");
      assert.equal(lintedDefinitions[0]?.name, "Delivery Renamed");
      assert.deepEqual(
        writes.map((write) => ({
          cwd: write.cwd,
          relativePath: write.relativePath,
        })),
        [{ cwd: workspaceRoot, relativePath: workflowFilePath }],
      );
      const writtenDefinition = yield* decodeWorkflowDefinitionJson(writes[0]!.contents);
      assert.equal(writtenDefinition.name, "Delivery Renamed");
      assert.deepEqual(loadedBoards, [
        { boardId, projectId, workspaceRoot, relativePath: workflowFilePath },
      ]);
      assert.deepEqual(
        versionRecords.map((record) => ({
          boardId: record.boardId,
          versionHash: record.versionHash,
          contentJson: record.contentJson,
          source: record.source,
        })),
        [
          {
            boardId,
            versionHash: sha256Hex(writes[0]!.contents),
            contentJson: writes[0]!.contents,
            source: "rename",
          },
        ],
      );
    }),
);

it.effect(
  "workflowRpcHandlers rolls the board file back when registration fails post-write, then a retry succeeds",
  () =>
    Effect.gen(function* () {
      const projectId = "project-rename-rpc" as ProjectId;
      const boardId = BoardId.make("project-rename-rpc__retry");
      const workspaceRoot = "/tmp/rename-rpc-retry";
      const workflowFilePath = ".t3/boards/retry.json";
      const originalDefinition = yield* decodeWorkflowDefinition({
        name: "Delivery",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      let fileContents = `${encodeWorkflowDefinitionJson(originalDefinition)}\n`;
      let registryDefinition = originalDefinition;
      let boardRow = {
        boardId,
        projectId,
        name: originalDefinition.name,
        workflowFilePath,
        workflowVersionHash: sha256Hex(fileContents),
        maxConcurrentTickets: 3,
      };
      let failNextRegistration = true;
      const writes: Array<{
        readonly cwd: string;
        readonly relativePath: string;
        readonly contents: string;
      }> = [];
      const loadedBoards: Array<{
        readonly boardId: BoardId;
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly relativePath: string;
      }> = [];
      const versionRecords: WorkflowBoardVersionRecordInput[] = [];

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
          stopAgentSessionsForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          editTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: () => Effect.succeed(boardRow),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(registryDefinition),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
          subscribe: () => Effect.succeed(Stream.empty),
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: (input) =>
            Effect.gen(function* () {
              loadedBoards.push(input);
              if (failNextRegistration) {
                failNextRegistration = false;
                return yield* new WorkflowRpcError({ message: "registration unavailable" });
              }

              const definition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
                Effect.orDie,
              );
              registryDefinition = definition;
              boardRow = {
                ...boardRow,
                name: definition.name,
                workflowVersionHash: sha256Hex(fileContents),
              };
              return input.boardId;
            }),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: {
          record: (input) =>
            Effect.sync(() => {
              versionRecords.push(input);
            }),
          list: () =>
            Effect.succeed(
              versionRecords.map((record, index) => ({
                versionId: versionRecords.length - index,
                versionHash: record.versionHash,
                source: record.source,
                createdAt: `2026-06-08T00:00:0${index}.000Z`,
              })),
            ),
          get: () => Effect.succeed(null),
          deleteForBoard: () => Effect.void,
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed(workspaceRoot),
        },
        workspaceFileSystem: {
          readFile: () => Effect.die("unused"),
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.succeed(fileContents),
          writeFile: (input: Parameters<WorkspaceFileSystem["Service"]["writeFile"]>[0]) =>
            Effect.sync(() => {
              writes.push(input);
              fileContents = input.contents;
              return { relativePath: input.relativePath };
            }),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () => Effect.die("unused"),
        },
        saveLocks: yield* makeWorkflowBoardSaveLocks,
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      const failed = yield* Effect.exit(
        invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.renameBoard, {
          boardId,
          name: "Delivery Renamed",
        }),
      );
      assert.strictEqual(failed._tag, "Failure");
      assert.equal(boardRow.name, "Delivery");
      assert.equal(registryDefinition.name, "Delivery");
      // Attempt 1 wrote the rename, then rolled the durable file back to the
      // original when registration failed (saves are all-or-nothing).
      const failedWrite = yield* decodeWorkflowDefinitionJson(writes[0]!.contents);
      assert.equal(failedWrite.name, "Delivery Renamed");
      assert.equal(writes.length, 2);
      const rolledBack = yield* decodeWorkflowDefinitionJson(writes[1]!.contents);
      assert.equal(rolledBack.name, "Delivery");

      yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.renameBoard, {
        boardId,
        name: "Delivery Renamed",
      });

      assert.equal(boardRow.name, "Delivery Renamed");
      assert.equal(registryDefinition.name, "Delivery Renamed");
      // 3 writes total: rename (attempt 1) → rollback restore → rename (retry).
      assert.deepEqual(
        writes.map((write) => write.relativePath),
        [workflowFilePath, workflowFilePath, workflowFilePath],
      );
      assert.deepEqual(
        loadedBoards.map((loaded) => loaded.relativePath),
        [workflowFilePath, workflowFilePath],
      );
      assert.deepEqual(
        versionRecords.map((record) => ({
          boardId: record.boardId,
          versionHash: record.versionHash,
          contentJson: record.contentJson,
          source: record.source,
        })),
        [
          {
            boardId,
            versionHash: sha256Hex(fileContents),
            contentJson: fileContents,
            source: "rename",
          },
        ],
      );
    }),
);

it.effect("workflowRpcHandlers rejects blank board rename names before touching the file", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-rename-rpc__blank");
    const sideEffects: string[] = [];
    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.sync(() => {
            sideEffects.push("get-board");
            return null;
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () =>
          Effect.sync(() => {
            sideEffects.push("lint");
            return [];
          }),
        loadAndRegister: () =>
          Effect.sync(() => {
            sideEffects.push("load");
            return boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () =>
          Effect.sync(() => {
            sideEffects.push("resolve");
            return "/tmp/blank-rename";
          }),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () =>
          Effect.sync(() => {
            sideEffects.push("read");
            return "{}";
          }),
        writeFile: () =>
          Effect.sync(() => {
            sideEffects.push("write");
            return { relativePath: ".t3/boards/blank.json" };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const blank = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.renameBoard, {
        boardId,
        name: "   ",
      }),
    );

    assert.strictEqual(blank._tag, "Failure");
    assert.deepEqual(sideEffects, []);

    const overlong = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.renameBoard, {
        boardId,
        name: "A".repeat(129),
      }),
    );
    assert.strictEqual(overlong._tag, "Failure");
    assert.deepEqual(sideEffects, []);
  }),
);

it.effect("workflowRpcHandlers treats unchanged board rename names as a no-op", () =>
  Effect.gen(function* () {
    const projectId = "project-rename-rpc" as ProjectId;
    const boardId = BoardId.make("project-rename-rpc__unchanged");
    const workspaceRoot = "/tmp/rename-rpc-unchanged";
    const workflowFilePath = ".t3/boards/unchanged.json";
    const definition = yield* decodeWorkflowDefinition({
      name: "Delivery",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const fileContents = `${encodeWorkflowDefinitionJson(definition)}\n`;
    const sideEffects: string[] = [];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId,
            name: "Delivery",
            workflowFilePath,
            workflowVersionHash: sha256Hex(fileContents),
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () =>
          Effect.sync(() => {
            sideEffects.push("lint");
            return [];
          }),
        loadAndRegister: () =>
          Effect.sync(() => {
            sideEffects.push("load");
            return boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: () =>
          Effect.sync(() => {
            sideEffects.push("version");
          }),
        list: () =>
          Effect.succeed([
            {
              versionId: 1,
              versionHash: sha256Hex(fileContents),
              source: "rename",
              createdAt: "2026-06-08T00:00:00.000Z",
            },
          ]),
        get: () => Effect.succeed(null),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(fileContents),
        writeFile: () =>
          Effect.sync(() => {
            sideEffects.push("write");
            return { relativePath: workflowFilePath };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      saveLocks: yield* makeWorkflowBoardSaveLocks,
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.renameBoard, {
      boardId,
      name: "Delivery",
    });

    assert.deepEqual(sideEffects, []);
  }),
);

it.effect("workflowRpcHandlers reports missing boards during rename without writing", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-rename-rpc__missing");
    const sideEffects: string[] = [];
    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: noopReadModel,
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () =>
          Effect.sync(() => {
            sideEffects.push("lint");
            return [];
          }),
        loadAndRegister: () =>
          Effect.sync(() => {
            sideEffects.push("load");
            return boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () =>
          Effect.sync(() => {
            sideEffects.push("resolve");
            return "/tmp/missing-rename";
          }),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () =>
          Effect.sync(() => {
            sideEffects.push("read");
            return "{}";
          }),
        writeFile: () =>
          Effect.sync(() => {
            sideEffects.push("write");
            return { relativePath: ".t3/boards/missing.json" };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      saveLocks: yield* makeWorkflowBoardSaveLocks,
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const result = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.renameBoard, {
        boardId,
        name: "Missing renamed",
      }),
    );

    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.isTrue(result.cause.toString().includes(`Workflow board ${boardId} was not found`));
    }
    assert.deepEqual(sideEffects, []);
  }),
);

it.effect(
  "workflowRpcHandlers serializes rename racing delete without resurrecting board state",
  () =>
    Effect.gen(function* () {
      const projectId = "project-rename-rpc" as ProjectId;
      const boardId = BoardId.make("project-rename-rpc__race-delete");
      const workspaceRoot = "/tmp/rename-rpc-race-delete";
      const workflowFilePath = ".t3/boards/race-delete.json";
      const originalDefinition = yield* decodeWorkflowDefinition({
        name: "Race Delete",
        lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
      });
      let filePresent = true;
      let fileContents = `${encodeWorkflowDefinitionJson(originalDefinition)}\n`;
      let registryDefinition: WorkflowDefinitionType | null = originalDefinition;
      let boardProjectionPresent = true;
      let boardRow = {
        boardId,
        projectId,
        name: originalDefinition.name,
        workflowFilePath,
        workflowVersionHash: sha256Hex(fileContents),
        maxConcurrentTickets: 3,
      };
      const versionRecords: WorkflowBoardVersionRecordInput[] = [];
      const renameWriteStarted = yield* Deferred.make<void>();
      const allowRenameWrite = yield* Deferred.make<void>();
      const saveLocks = yield* makeWorkflowBoardSaveLocks;

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
          stopAgentSessionsForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          editTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: () => Effect.succeed(boardProjectionPresent ? boardRow : null),
          deleteBoard: () =>
            Effect.sync(() => {
              boardProjectionPresent = false;
            }),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () =>
            Effect.sync(() => {
              registryDefinition = null;
            }),
          getDefinition: () => Effect.succeed(registryDefinition),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
          subscribe: () => Effect.succeed(Stream.empty),
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: (input) =>
            Effect.gen(function* () {
              const definition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
                Effect.orDie,
              );
              registryDefinition = definition;
              boardRow = {
                ...boardRow,
                name: definition.name,
                workflowVersionHash: sha256Hex(fileContents),
              };
              boardProjectionPresent = true;
              return input.boardId;
            }),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: {
          record: (input) =>
            Effect.sync(() => {
              versionRecords.push(input);
            }),
          list: () => Effect.succeed([]),
          get: () => Effect.succeed(null),
          deleteForBoard: () =>
            Effect.sync(() => {
              versionRecords.splice(0, versionRecords.length);
            }),
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed(workspaceRoot),
        },
        workspaceFileSystem: {
          readFile: () => Effect.die("unused"),
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.succeed(fileContents),
          writeFile: (input: Parameters<WorkspaceFileSystem["Service"]["writeFile"]>[0]) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(renameWriteStarted, undefined);
              yield* Deferred.await(allowRenameWrite);
              filePresent = true;
              fileContents = input.contents;
              return { relativePath: input.relativePath };
            }),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () =>
            Effect.sync(() => {
              filePresent = false;
            }),
        },
        saveLocks,
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      const renameFiber = yield* invokeWorkflowHandler<void>(
        handlers,
        WORKFLOW_WS_METHODS.renameBoard,
        {
          boardId,
          name: "Race Delete Renamed",
        },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(renameWriteStarted);
      const deleteFiber = yield* invokeWorkflowHandler<void>(
        handlers,
        WORKFLOW_WS_METHODS.deleteBoard,
        {
          boardId,
        },
      ).pipe(Effect.forkChild);
      yield* Deferred.succeed(allowRenameWrite, undefined);

      yield* Fiber.join(renameFiber);
      yield* Fiber.join(deleteFiber);

      assert.isFalse(filePresent);
      assert.isFalse(boardProjectionPresent);
      assert.isNull(registryDefinition);
      assert.deepEqual(versionRecords, []);
    }),
);

it.effect("workflowRpcHandlers lists board versions and lazy-imports missing history", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-version-rpc__delivery");
    const otherBoardId = BoardId.make("project-version-rpc__other");
    const projectId = "project-version-rpc" as ProjectId;
    const workspaceRoot = "/tmp/project-version-rpc-root";
    const workflowFilePath = ".t3/boards/delivery.json";
    const importedDefinition = yield* decodeWorkflowDefinition({
      name: "Imported Delivery",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const savedDefinition = yield* decodeWorkflowDefinition({
      name: "Saved Delivery",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual" },
        { key: "review", name: "Review", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const importedRaw = `${encodeWorkflowDefinitionJson(importedDefinition)}\n`;
    const savedRaw = `${encodeWorkflowDefinitionJson(savedDefinition)}\n`;
    const importedHash = sha256Hex(importedRaw);
    const savedHash = sha256Hex(savedRaw);
    const recorded: WorkflowBoardVersionRecordInput[] = [];
    const versions: Array<{
      readonly boardId: BoardId;
      readonly versionId: number;
      readonly versionHash: string;
      readonly contentJson: string;
      readonly source: WorkflowBoardVersionSource;
      readonly createdAt: string;
    }> = [];
    let nextVersionId = 1;

    const addVersion = (input: WorkflowBoardVersionRecordInput, createdAt: string) => {
      versions.push({
        boardId: input.boardId,
        versionId: nextVersionId,
        versionHash: input.versionHash,
        contentJson: input.contentJson,
        source: input.source,
        createdAt,
      });
      nextVersionId += 1;
    };

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: (inputBoardId) =>
          Effect.succeed(
            inputBoardId === boardId
              ? {
                  boardId,
                  projectId,
                  name: "Imported Delivery",
                  workflowFilePath,
                  workflowVersionHash: importedHash,
                  maxConcurrentTickets: 3,
                }
              : null,
          ),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.die("unused"),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.die("unused"),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) =>
          Effect.sync(() => {
            recorded.push(input);
            addVersion(input, "2026-06-08T12:00:00.000Z");
          }),
        list: (inputBoardId) =>
          Effect.succeed(
            versions
              .filter((version) => version.boardId === inputBoardId)
              .toSorted((left, right) => right.versionId - left.versionId)
              .map(({ contentJson: _contentJson, boardId: _boardId, ...summary }) => summary),
          ),
        get: (inputBoardId, versionId) =>
          Effect.succeed(
            versions.find(
              (version) => version.boardId === inputBoardId && version.versionId === versionId,
            ) ?? null,
          ),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: (inputProjectId) =>
          Effect.sync(() => {
            assert.equal(inputProjectId, projectId);
            return workspaceRoot;
          }),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: (input: Parameters<WorkspaceFileSystem["Service"]["readFileString"]>[0]) =>
          Effect.sync(() => {
            assert.deepEqual(input, { cwd: workspaceRoot, relativePath: workflowFilePath });
            return importedRaw;
          }),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const importedVersions = yield* invokeWorkflowHandler<
      ReadonlyArray<{
        readonly versionId: number;
        readonly versionHash: string;
        readonly source: string;
        readonly createdAt: string;
        readonly isCurrent: boolean;
      }>
    >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });

    assert.deepEqual(recorded, [
      {
        boardId,
        versionHash: importedHash,
        contentJson: importedRaw,
        source: "import",
      },
    ]);
    assert.deepEqual(importedVersions, [
      {
        versionId: 1,
        versionHash: importedHash,
        source: "import",
        createdAt: "2026-06-08T12:00:00.000Z",
        isCurrent: true,
      },
    ]);
    assert.equal("contentJson" in importedVersions[0]!, false);

    addVersion(
      {
        boardId,
        versionHash: savedHash,
        contentJson: savedRaw,
        source: "save",
      },
      "2026-06-08T12:05:00.000Z",
    );
    const listedVersions = yield* invokeWorkflowHandler<
      ReadonlyArray<{
        readonly versionId: number;
        readonly versionHash: string;
        readonly source: string;
        readonly createdAt: string;
        readonly isCurrent: boolean;
      }>
    >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });
    assert.deepEqual(listedVersions, [
      {
        versionId: 2,
        versionHash: savedHash,
        source: "save",
        createdAt: "2026-06-08T12:05:00.000Z",
        isCurrent: true,
      },
      {
        versionId: 1,
        versionHash: importedHash,
        source: "import",
        createdAt: "2026-06-08T12:00:00.000Z",
        isCurrent: false,
      },
    ]);

    const importedVersion = yield* invokeWorkflowHandler<{
      readonly versionId: number;
      readonly definition: unknown;
      readonly versionHash: string;
      readonly source: string;
      readonly createdAt: string;
    }>(handlers, WORKFLOW_WS_METHODS.getBoardVersion, { boardId, versionId: 1 });
    assert.equal(importedVersion.versionId, 1);
    assert.equal(
      (importedVersion.definition as { readonly name: string }).name,
      "Imported Delivery",
    );
    assert.equal(importedVersion.versionHash, importedHash);
    assert.equal(importedVersion.source, "import");
    assert.equal(importedVersion.createdAt, "2026-06-08T12:00:00.000Z");

    const missingVersion = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.getBoardVersion, {
        boardId,
        versionId: 999,
      }),
    );
    assert.strictEqual(missingVersion._tag, "Failure");

    const wrongBoardVersion = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.getBoardVersion, {
        boardId: otherBoardId,
        versionId: 1,
      }),
    );
    assert.strictEqual(wrongBoardVersion._tag, "Failure");
  }),
);

it.effect("workflowRpcHandlers records only one lazy import for concurrent history opens", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-version-rpc__concurrent-import");
    const projectId = "project-version-rpc" as ProjectId;
    const workspaceRoot = "/tmp/project-version-rpc-root";
    const workflowFilePath = ".t3/boards/concurrent-import.json";
    const importedDefinition = yield* decodeWorkflowDefinition({
      name: "Concurrent Import",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const importedRaw = `${encodeWorkflowDefinitionJson(importedDefinition)}\n`;
    const importedHash = sha256Hex(importedRaw);
    const recorded: WorkflowBoardVersionRecordInput[] = [];
    const versions: Array<{
      readonly boardId: BoardId;
      readonly versionId: number;
      readonly versionHash: string;
      readonly contentJson: string;
      readonly source: WorkflowBoardVersionSource;
      readonly createdAt: string;
    }> = [];
    let nextVersionId = 1;
    let initialListCalls = 0;
    const initialListsEntered = yield* Deferred.make<void>();
    const saveLocks = yield* makeWorkflowBoardSaveLocks;

    const addVersion = (input: WorkflowBoardVersionRecordInput) => {
      versions.push({
        boardId: input.boardId,
        versionId: nextVersionId,
        versionHash: input.versionHash,
        contentJson: input.contentJson,
        source: input.source,
        createdAt: "2026-06-08T12:00:00.000Z",
      });
      nextVersionId += 1;
    };

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId,
            name: importedDefinition.name,
            workflowFilePath,
            workflowVersionHash: importedHash,
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.die("unused"),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      saveLocks,
      fileLoader: {
        lintDefinition: () => Effect.die("unused"),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) =>
          Effect.sync(() => {
            recorded.push(input);
            addVersion(input);
          }),
        list: (inputBoardId) =>
          Effect.gen(function* () {
            const snapshot = versions
              .filter((version) => version.boardId === inputBoardId)
              .toSorted((left, right) => right.versionId - left.versionId)
              .map(({ contentJson: _contentJson, boardId: _boardId, ...summary }) => summary);
            if (initialListCalls < 2) {
              initialListCalls += 1;
              if (initialListCalls === 2) {
                yield* Deferred.succeed(initialListsEntered, undefined);
              } else {
                yield* Deferred.await(initialListsEntered);
              }
            }
            return snapshot;
          }),
        get: () => Effect.succeed(null),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(importedRaw),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const listVersions = invokeWorkflowHandler<
      ReadonlyArray<{
        readonly source: string;
        readonly isCurrent: boolean;
      }>
    >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });

    const first = yield* listVersions.pipe(Effect.forkChild);
    const second = yield* listVersions.pipe(Effect.forkChild);
    const results = [yield* Fiber.join(first), yield* Fiber.join(second)];

    assert.deepEqual(recorded, [
      {
        boardId,
        versionHash: importedHash,
        contentJson: importedRaw,
        source: "import",
      },
    ]);
    assert.deepEqual(
      results.map((result) => result.map((version) => version.source)),
      [["import"], ["import"]],
    );
  }),
);

it.effect("workflowRpcHandlers serializes createBoard against lazy history import", () =>
  Effect.gen(function* () {
    const projectId = "project-create-import-race" as ProjectId;
    const boardId = BoardId.make(`${projectId}__race-board`);
    const workspaceRoot = "/tmp/project-create-import-race-root";
    const saveLocks = yield* makeWorkflowBoardSaveLocks;
    const createdBoardRegistered = yield* Deferred.make<void>();
    const versions: Array<{
      readonly boardId: BoardId;
      readonly versionId: number;
      readonly versionHash: string;
      readonly contentJson: string;
      readonly source: WorkflowBoardVersionSource;
      readonly createdAt: string;
    }> = [];
    let nextVersionId = 1;
    let fileContents = "";
    let registryDefinition: WorkflowDefinitionType | null = null;
    let boardRow: {
      readonly boardId: BoardId;
      readonly projectId: ProjectId;
      readonly name: string;
      readonly workflowFilePath: string;
      readonly workflowVersionHash: string;
      readonly maxConcurrentTickets: number;
    } | null = null;

    const versionSummaries = (inputBoardId: BoardId) =>
      versions
        .filter((version) => version.boardId === inputBoardId)
        .toSorted((left, right) => right.versionId - left.versionId)
        .map(({ contentJson: _contentJson, boardId: _boardId, ...summary }) => summary);

    const recordVersion = (input: WorkflowBoardVersionRecordInput) => {
      const newest = versionSummaries(input.boardId)[0];
      if (newest?.versionHash === input.versionHash) {
        return;
      }
      versions.push({
        boardId: input.boardId,
        versionId: nextVersionId,
        versionHash: input.versionHash,
        contentJson: input.contentJson,
        source: input.source,
        createdAt: "2026-06-08T12:00:00.000Z",
      });
      nextVersionId += 1;
    };

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: (inputBoardId) => Effect.succeed(inputBoardId === boardId ? boardRow : null),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(registryDefinition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      saveLocks,
      fileLoader: {
        lintDefinition: () => Effect.die("unused"),
        loadAndRegister: (input) =>
          Effect.gen(function* () {
            registryDefinition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
              Effect.orDie,
            );
            boardRow = {
              boardId: input.boardId,
              projectId: input.projectId,
              name: registryDefinition.name,
              workflowFilePath: input.relativePath,
              workflowVersionHash: sha256Hex(fileContents),
              maxConcurrentTickets: 3,
            };
            yield* Deferred.succeed(createdBoardRegistered, undefined);
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            return input.boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) => Effect.sync(() => recordVersion(input)),
        list: (inputBoardId) => Effect.sync(() => versionSummaries(inputBoardId)),
        get: () => Effect.succeed(null),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(fileContents),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: (input: Parameters<WorkspaceFileSystem["Service"]["createFileExclusive"]>[0]) =>
          Effect.sync(() => {
            fileContents = input.contents;
            return { relativePath: input.relativePath };
          }),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const createFiber = yield* invokeWorkflowHandler<{
      readonly boardId: BoardId;
    }>(handlers, WORKFLOW_WS_METHODS.createBoard, {
      projectId,
      name: "Race Board",
      agent: { instance: "codex_main", model: "gpt-5.5" },
    }).pipe(Effect.forkChild);

    yield* Deferred.await(createdBoardRegistered);
    const listFiber = yield* invokeWorkflowHandler<
      ReadonlyArray<{
        readonly source: string;
        readonly isCurrent: boolean;
      }>
    >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId }).pipe(Effect.forkChild);

    const created = yield* Fiber.join(createFiber);
    const listed = yield* Fiber.join(listFiber);

    assert.equal(created.boardId, boardId);
    assert.deepEqual(
      versions.map((version) => version.source),
      ["create"],
    );
    assert.deepEqual(
      listed.map((version) => ({ source: version.source, isCurrent: version.isCurrent })),
      [{ source: "create", isCurrent: true }],
    );
  }),
);

it.effect("workflowRpcHandlers skips lazy import when history appears after an empty read", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-version-rpc__history-populated");
    const projectId = "project-version-rpc" as ProjectId;
    const workspaceRoot = "/tmp/project-version-rpc-root";
    const workflowFilePath = ".t3/boards/history-populated.json";
    const importedDefinition = yield* decodeWorkflowDefinition({
      name: "Imported Before Existing Save",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const savedDefinition = yield* decodeWorkflowDefinition({
      name: "Existing Save",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const importedRaw = `${encodeWorkflowDefinitionJson(importedDefinition)}\n`;
    const savedRaw = `${encodeWorkflowDefinitionJson(savedDefinition)}\n`;
    const importedHash = sha256Hex(importedRaw);
    const savedHash = sha256Hex(savedRaw);
    const recorded: WorkflowBoardVersionRecordInput[] = [];
    const versions: Array<{
      readonly boardId: BoardId;
      readonly versionId: number;
      readonly versionHash: string;
      readonly contentJson: string;
      readonly source: WorkflowBoardVersionSource;
      readonly createdAt: string;
    }> = [
      {
        boardId,
        versionId: 1,
        versionHash: savedHash,
        contentJson: savedRaw,
        source: "save",
        createdAt: "2026-06-08T12:05:00.000Z",
      },
    ];
    let nextVersionId = 2;
    let listCalls = 0;
    const saveLocks = yield* makeWorkflowBoardSaveLocks;

    const addVersion = (input: WorkflowBoardVersionRecordInput) => {
      versions.push({
        boardId: input.boardId,
        versionId: nextVersionId,
        versionHash: input.versionHash,
        contentJson: input.contentJson,
        source: input.source,
        createdAt: "2026-06-08T12:00:00.000Z",
      });
      nextVersionId += 1;
    };

    const versionSummaries = (inputBoardId: BoardId) =>
      versions
        .filter((version) => version.boardId === inputBoardId)
        .toSorted((left, right) => right.versionId - left.versionId)
        .map(({ contentJson: _contentJson, boardId: _boardId, ...summary }) => summary);

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId,
            name: importedDefinition.name,
            workflowFilePath,
            workflowVersionHash: importedHash,
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(importedDefinition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      saveLocks,
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) =>
          Effect.sync(() => {
            recorded.push(input);
            addVersion(input);
          }),
        list: (inputBoardId) =>
          Effect.sync(() => {
            listCalls += 1;
            return listCalls === 1 ? [] : versionSummaries(inputBoardId);
          }),
        get: () => Effect.succeed(null),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(importedRaw),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const listedVersions = yield* invokeWorkflowHandler<
      ReadonlyArray<{
        readonly source: string;
        readonly isCurrent: boolean;
      }>
    >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });
    assert.deepEqual(recorded, []);
    assert.deepEqual(
      listedVersions.map((version) => ({
        source: version.source,
        isCurrent: version.isCurrent,
      })),
      [{ source: "save", isCurrent: true }],
    );
  }),
);

versionRoundTripLayer("workflowRpcHandlers version history round trip", (it) => {
  it.effect("imports, saves, loads, and re-saves a reverted board version", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const boardId = BoardId.make("project-version-round-trip__delivery");
      const projectId = "project-version-round-trip" as ProjectId;
      const workspaceRoot = "/tmp/project-version-round-trip-root";
      const workflowFilePath = ".t3/boards/delivery.json";
      const importedDefinition = yield* decodeWorkflowDefinition({
        name: "Imported Delivery",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      const savedDefinition = yield* decodeWorkflowDefinition({
        name: "Saved Delivery",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual" },
          { key: "review", name: "Review", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      const currentDefinition = yield* decodeWorkflowDefinition({
        name: "Current Delivery",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual" },
          { key: "review", name: "Review", entry: "auto" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      let fileContents = `${encodeWorkflowDefinitionJson(importedDefinition)}\n`;
      let registryDefinition = importedDefinition;
      let boardRow = {
        boardId,
        projectId,
        name: importedDefinition.name,
        workflowFilePath,
        workflowVersionHash: sha256Hex(fileContents),
        maxConcurrentTickets: 3,
      };

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
          stopAgentSessionsForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          editTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: (inputBoardId) => Effect.succeed(inputBoardId === boardId ? boardRow : null),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(registryDefinition),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
          subscribe: () => Effect.succeed(Stream.empty),
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: (input) =>
            Effect.gen(function* () {
              const definition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
                Effect.mapError(
                  (cause) =>
                    new WorkflowRpcError({
                      message: "round-trip workflow definition decode failed",
                      cause,
                    }),
                ),
              );
              registryDefinition = definition;
              boardRow = {
                ...boardRow,
                name: definition.name,
                workflowVersionHash: sha256Hex(fileContents),
              };
              return input.boardId;
            }),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore,
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed(workspaceRoot),
        },
        workspaceFileSystem: {
          readFile: () => Effect.die("unused"),
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.succeed(fileContents),
          writeFile: (input: Parameters<WorkspaceFileSystem["Service"]["writeFile"]>[0]) =>
            Effect.sync(() => {
              fileContents = input.contents;
              return { relativePath: input.relativePath };
            }),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () => Effect.die("unused"),
        },
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      const importedVersions = yield* invokeWorkflowHandler<
        ReadonlyArray<{
          readonly versionId: number;
          readonly source: string;
          readonly isCurrent: boolean;
        }>
      >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });
      assert.deepEqual(
        importedVersions.map((version) => ({
          source: version.source,
          isCurrent: version.isCurrent,
        })),
        [{ source: "import", isCurrent: true }],
      );

      const firstSave = yield* invokeWorkflowHandler<
        | { readonly ok: true; readonly versionHash: string }
        | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: encodeWorkflowDefinition(savedDefinition),
        expectedVersionHash: boardRow.workflowVersionHash,
      });
      assert.equal(firstSave.ok, true);
      if (firstSave.ok !== true) {
        assert.fail("expected first save to succeed");
      }

      // PR review: the save path enforces the import DoS caps. An oversized
      // definition (>MAX_IMPORT_LANES) is rejected with lintErrors and never
      // written — and leaves the version hash unchanged so the chain continues.
      const contentAfterFirstSave = fileContents;
      const oversizedDefinition = yield* decodeWorkflowDefinition({
        name: "Too Many Lanes",
        lanes: [
          ...Array.from({ length: 1001 }, (_, index) => ({
            key: `overflow-${index}`,
            name: `Overflow ${index}`,
            entry: "manual",
          })),
          { key: "done-overflow", name: "Done", entry: "manual", terminal: true },
        ],
      });
      const oversizedSave = yield* invokeWorkflowHandler<
        | { readonly ok: true; readonly versionHash: string }
        | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: encodeWorkflowDefinition(oversizedDefinition),
        expectedVersionHash: firstSave.versionHash,
      });
      assert.equal(oversizedSave.ok, false);
      if (oversizedSave.ok !== false) {
        assert.fail("expected oversized save to be rejected by the size cap");
      }
      assert.ok(oversizedSave.lintErrors.length > 0);
      assert.equal(fileContents, contentAfterFirstSave); // no write on rejection

      const secondSave = yield* invokeWorkflowHandler<
        | { readonly ok: true; readonly versionHash: string }
        | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: encodeWorkflowDefinition(currentDefinition),
        expectedVersionHash: firstSave.versionHash,
      });
      assert.equal(secondSave.ok, true);
      if (secondSave.ok !== true) {
        assert.fail("expected second save to succeed");
      }

      const versionsBeforeRevert = yield* invokeWorkflowHandler<
        ReadonlyArray<{
          readonly versionId: number;
          readonly versionHash: string;
          readonly source: string;
          readonly isCurrent: boolean;
        }>
      >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });
      assert.deepEqual(
        versionsBeforeRevert.map((version) => ({
          source: version.source,
          isCurrent: version.isCurrent,
        })),
        [
          { source: "save", isCurrent: true },
          { source: "save", isCurrent: false },
          { source: "import", isCurrent: false },
        ],
      );

      const importVersion = versionsBeforeRevert.at(-1);
      assert.isDefined(importVersion);
      const loadedImport = yield* invokeWorkflowHandler<{
        readonly versionId: number;
        readonly definition: WorkflowDefinitionEncoded;
        readonly versionHash: string;
        readonly source: string;
      }>(handlers, WORKFLOW_WS_METHODS.getBoardVersion, {
        boardId,
        versionId: importVersion.versionId,
      });
      assert.equal(loadedImport.source, "import");
      assert.equal(loadedImport.definition.name, "Imported Delivery");

      const revertSave = yield* invokeWorkflowHandler<
        | { readonly ok: true; readonly versionHash: string }
        | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: loadedImport.definition,
        expectedVersionHash: secondSave.versionHash,
        source: "revert",
      });
      assert.equal(revertSave.ok, true);

      const versionsAfterRevert = yield* invokeWorkflowHandler<
        ReadonlyArray<{
          readonly versionHash: string;
          readonly source: string;
          readonly isCurrent: boolean;
        }>
      >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });
      assert.deepEqual(
        versionsAfterRevert.map((version) => ({
          versionHash: version.versionHash,
          source: version.source,
          isCurrent: version.isCurrent,
        })),
        [
          {
            versionHash: loadedImport.versionHash,
            source: "revert",
            isCurrent: true,
          },
          {
            versionHash: secondSave.versionHash,
            source: "save",
            isCurrent: false,
          },
          {
            versionHash: firstSave.versionHash,
            source: "save",
            isCurrent: false,
          },
          {
            versionHash: loadedImport.versionHash,
            source: "import",
            isCurrent: false,
          },
        ],
      );
    }),
  );
});

it.effect("workflowRpcHandlers rejects lint-invalid board saves without writing", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-editor-rpc__invalid");
    const definition = yield* decodeWorkflowDefinition({
      name: "Invalid",
      lanes: [{ key: "queue", name: "Queue", entry: "manual", wipLimit: 0 }],
    });
    const definitionEncoded = encodeWorkflowDefinition(definition);
    const currentRaw = `${encodeWorkflowDefinitionJson(definition)}\n`;
    const currentHash = sha256Hex(currentRaw);
    let writeCount = 0;
    const lintErrors: ReadonlyArray<LintError> = [
      {
        code: "invalid_wip_limit",
        message: "Lane queue wipLimit must be at least 1",
        laneKey: "queue",
      },
    ];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId: "project-editor-rpc",
            name: "Invalid",
            workflowFilePath: ".t3/boards/invalid.json",
            workflowVersionHash: currentHash,
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed(lintErrors),
        loadAndRegister: () => Effect.die("loadAndRegister must not run after lint failure"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/editor-rpc-project"),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(currentRaw),
        writeFile: () =>
          Effect.sync(() => {
            writeCount += 1;
            return { relativePath: ".t3/boards/invalid.json" };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const saved = yield* invokeWorkflowHandler<{
      readonly ok: false;
      readonly lintErrors: ReadonlyArray<{
        readonly code: string;
        readonly message: string;
        readonly laneKey?: string;
      }>;
    }>(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: definitionEncoded,
      expectedVersionHash: currentHash,
    });

    assert.equal(saved.ok, false);
    assert.deepEqual(saved.lintErrors, lintErrors);
    assert.equal(writeCount, 0);
  }),
);

it.effect("workflowRpcHandlers rejects stale board saves without writing", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-editor-rpc__stale");
    const definition = yield* decodeWorkflowDefinition({
      name: "Stale",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const definitionEncoded = encodeWorkflowDefinition(definition);
    const currentRaw = `${encodeWorkflowDefinitionJson(definition)}\n`;
    const currentHash = sha256Hex(currentRaw);
    const workspaceRoot = "/tmp/editor-rpc-project";
    let writeCount = 0;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId: "project-editor-rpc",
            name: "Stale",
            workflowFilePath: ".t3/boards/stale.json",
            workflowVersionHash: currentHash,
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.die("lintDefinition must not run after version conflict"),
        loadAndRegister: () => Effect.die("loadAndRegister must not run after version conflict"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: (input: Parameters<WorkspaceFileSystem["Service"]["readFileString"]>[0]) =>
          Effect.sync(() => {
            assert.deepEqual(input, {
              cwd: workspaceRoot,
              relativePath: ".t3/boards/stale.json",
            });
            return currentRaw;
          }),
        writeFile: () =>
          Effect.sync(() => {
            writeCount += 1;
            return { relativePath: ".t3/boards/stale.json" };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const saved = yield* invokeWorkflowHandler<
      | { readonly ok: true; readonly versionHash: string }
      | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      | { readonly ok: false; readonly conflict: true; readonly currentVersionHash: string }
    >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: definitionEncoded,
      expectedVersionHash: "hash-stale",
    });

    assert.deepEqual(saved, {
      ok: false,
      conflict: true,
      currentVersionHash: currentHash,
    });
    assert.equal(writeCount, 0);
  }),
);

it.effect("workflowRpcHandlers rejects saves when the board file changed on disk", () =>
  Effect.gen(function* () {
    const projectId = "project-editor-rpc" as ProjectId;
    const boardId = BoardId.make("project-editor-rpc__external-edit");
    const workspaceRoot = "/tmp/editor-rpc-project";
    const workflowFilePath = ".t3/boards/external-edit.json";
    const originalDefinition = yield* decodeWorkflowDefinition({
      name: "External Edit",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const editedDefinition = yield* decodeWorkflowDefinition({
      name: "External Edit Saved",
      lanes: [{ key: "queue", name: "Queue Saved", entry: "manual" }],
    });
    const externalDefinition = yield* decodeWorkflowDefinition({
      name: "External Edit Hand Edited",
      lanes: [{ key: "queue", name: "Queue Hand Edited", entry: "manual" }],
    });
    const originalRaw = `${encodeWorkflowDefinitionJson(originalDefinition)}\n`;
    const externalRaw = `${encodeWorkflowDefinitionJson(externalDefinition)}\n`;
    const originalHash = sha256Hex(originalRaw);
    const externalHash = sha256Hex(externalRaw);
    let fileContents = originalRaw;
    let writeCount = 0;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId,
            name: "External Edit",
            workflowFilePath,
            workflowVersionHash: originalHash,
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(originalDefinition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("loadAndRegister must not run after on-disk conflict"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: (input: Parameters<WorkspaceFileSystem["Service"]["readFileString"]>[0]) =>
          Effect.sync(() => {
            assert.deepEqual(input, { cwd: workspaceRoot, relativePath: workflowFilePath });
            return fileContents;
          }),
        writeFile: (input: Parameters<WorkspaceFileSystem["Service"]["writeFile"]>[0]) =>
          Effect.sync(() => {
            writeCount += 1;
            fileContents = input.contents;
            return { relativePath: input.relativePath };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const loaded = yield* invokeWorkflowHandler<{
      readonly versionHash: string;
    }>(handlers, WORKFLOW_WS_METHODS.getBoardDefinition, { boardId });
    fileContents = externalRaw;

    const saved = yield* invokeWorkflowHandler<
      | { readonly ok: true; readonly versionHash: string }
      | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      | { readonly ok: false; readonly conflict: true; readonly currentVersionHash: string }
    >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: encodeWorkflowDefinition(editedDefinition),
      expectedVersionHash: loaded.versionHash,
    });

    assert.deepEqual(saved, {
      ok: false,
      conflict: true,
      currentVersionHash: externalHash,
    });
    assert.equal(writeCount, 0);
    assert.equal(fileContents, externalRaw);
  }),
);

it.effect("workflowRpcHandlers serializes same-base board saves so only one succeeds", () =>
  Effect.gen(function* () {
    const projectId = "project-editor-rpc" as ProjectId;
    const boardId = BoardId.make("project-editor-rpc__concurrent");
    const workspaceRoot = "/tmp/editor-rpc-project";
    const workflowFilePath = ".t3/boards/concurrent.json";
    const baseDefinition = yield* decodeWorkflowDefinition({
      name: "Concurrent",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const firstDefinition = yield* decodeWorkflowDefinition({
      name: "Concurrent First",
      lanes: [{ key: "queue", name: "Queue First", entry: "manual" }],
    });
    const secondDefinition = yield* decodeWorkflowDefinition({
      name: "Concurrent Second",
      lanes: [{ key: "queue", name: "Queue Second", entry: "manual" }],
    });
    const baseRaw = `${encodeWorkflowDefinitionJson(baseDefinition)}\n`;
    const baseHash = sha256Hex(baseRaw);
    let fileContents = baseRaw;
    let registryDefinition = baseDefinition;
    let boardRow = {
      boardId,
      projectId,
      name: baseDefinition.name,
      workflowFilePath,
      workflowVersionHash: baseHash,
      maxConcurrentTickets: 3,
    };
    let writeCount = 0;
    const firstWriteEntered = yield* Deferred.make<void>();
    const saveLocks = yield* makeWorkflowBoardSaveLocks;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () => Effect.succeed(boardRow),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(registryDefinition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      saveLocks,
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: (input) =>
          Effect.gen(function* () {
            registryDefinition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
              Effect.orDie,
            );
            boardRow = {
              ...boardRow,
              name: registryDefinition.name,
              workflowVersionHash: sha256Hex(fileContents),
            };
            return input.boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(fileContents),
        writeFile: (input: Parameters<WorkspaceFileSystem["Service"]["writeFile"]>[0]) =>
          Effect.gen(function* () {
            writeCount += 1;
            if (writeCount === 1) {
              yield* Deferred.succeed(firstWriteEntered, undefined);
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
            }
            fileContents = input.contents;
            return { relativePath: input.relativePath };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const save = (definition: WorkflowDefinitionType) =>
      invokeWorkflowHandler<
        | { readonly ok: true; readonly versionHash: string }
        | { readonly ok: false; readonly lintErrors: readonly unknown[] }
        | { readonly ok: false; readonly conflict: true; readonly currentVersionHash: string }
      >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: encodeWorkflowDefinition(definition),
        expectedVersionHash: baseHash,
      });

    const first = yield* save(firstDefinition).pipe(Effect.forkChild);
    yield* Deferred.await(firstWriteEntered);
    const second = yield* save(secondDefinition).pipe(Effect.forkChild);

    const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
    assert.equal(results.filter((result) => result.ok === true).length, 1);
    const conflict = results.find((result) => result.ok === false && "conflict" in result);
    assert.deepEqual(conflict, {
      ok: false,
      conflict: true,
      currentVersionHash: sha256Hex(fileContents),
    });
    assert.equal(writeCount, 1);
  }),
);

it.effect("workflowRpcHandlers serializes deleteBoard with an in-flight save", () =>
  Effect.gen(function* () {
    const projectId = "project-editor-rpc" as ProjectId;
    const boardId = BoardId.make("project-editor-rpc__delete-save-race");
    const workspaceRoot = "/tmp/editor-rpc-project";
    const workflowFilePath = ".t3/boards/delete-save-race.json";
    const baseDefinition = yield* decodeWorkflowDefinition({
      name: "Delete Save Race",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const savedDefinition = yield* decodeWorkflowDefinition({
      name: "Delete Save Race Saved",
      lanes: [{ key: "queue", name: "Queue Saved", entry: "manual" }],
    });
    const baseRaw = `${encodeWorkflowDefinitionJson(baseDefinition)}\n`;
    const baseHash = sha256Hex(baseRaw);
    let fileContents = baseRaw;
    let registryDefinition: WorkflowDefinitionType | null = baseDefinition;
    let boardRow: {
      readonly boardId: BoardId;
      readonly projectId: ProjectId;
      readonly name: string;
      readonly workflowFilePath: string;
      readonly workflowVersionHash: string;
      readonly maxConcurrentTickets: number;
    } | null = {
      boardId,
      projectId,
      name: baseDefinition.name,
      workflowFilePath,
      workflowVersionHash: baseHash,
      maxConcurrentTickets: 3,
    };
    const versions: WorkflowBoardVersionRecordInput[] = [];
    const saveWriteEntered = yield* Deferred.make<void>();
    const saveLocks = yield* makeWorkflowBoardSaveLocks;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: (inputBoardId) => Effect.succeed(inputBoardId === boardId ? boardRow : null),
        deleteBoard: (inputBoardId) =>
          Effect.sync(() => {
            if (inputBoardId === boardId) {
              boardRow = null;
            }
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: (inputBoardId) =>
          Effect.sync(() => {
            if (inputBoardId === boardId) {
              registryDefinition = null;
            }
          }),
        getDefinition: () => Effect.succeed(registryDefinition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      saveLocks,
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: (input) =>
          Effect.gen(function* () {
            registryDefinition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
              Effect.orDie,
            );
            boardRow = {
              boardId: input.boardId,
              projectId: input.projectId,
              name: registryDefinition.name,
              workflowFilePath: input.relativePath,
              workflowVersionHash: sha256Hex(fileContents),
              maxConcurrentTickets: 3,
            };
            return input.boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) =>
          Effect.sync(() => {
            versions.push(input);
          }),
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
        deleteForBoard: (inputBoardId) =>
          Effect.sync(() => {
            for (let index = versions.length - 1; index >= 0; index -= 1) {
              if (versions[index]?.boardId === inputBoardId) {
                versions.splice(index, 1);
              }
            }
          }),
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(fileContents),
        writeFile: (input: Parameters<WorkspaceFileSystem["Service"]["writeFile"]>[0]) =>
          Effect.gen(function* () {
            fileContents = input.contents;
            yield* Deferred.succeed(saveWriteEntered, undefined);
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            return { relativePath: input.relativePath };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: (input: Parameters<WorkspaceFileSystem["Service"]["deleteFile"]>[0]) =>
          Effect.sync(() => {
            assert.deepEqual(input, { cwd: workspaceRoot, relativePath: workflowFilePath });
            fileContents = "";
          }),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const saveFiber = yield* invokeWorkflowHandler<{
      readonly ok: true;
      readonly versionHash: string;
    }>(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: encodeWorkflowDefinition(savedDefinition),
      expectedVersionHash: baseHash,
    }).pipe(Effect.forkChild);

    yield* Deferred.await(saveWriteEntered);
    const deleteFiber = yield* invokeWorkflowHandler<void>(
      handlers,
      WORKFLOW_WS_METHODS.deleteBoard,
      { boardId },
    ).pipe(Effect.forkChild);

    const saved = yield* Fiber.join(saveFiber);
    yield* Fiber.join(deleteFiber);

    assert.equal(saved.ok, true);
    assert.equal(boardRow, null);
    assert.equal(registryDefinition, null);
    assert.deepEqual(versions, []);
  }),
);

it.effect("workflowRpcHandlers rejects unsafe instruction paths without writing", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-editor-rpc__unsafe-instruction");
    const definition = yield* decodeWorkflowDefinition({
      name: "Unsafe Instruction",
      lanes: [
        {
          key: "run",
          name: "Run",
          entry: "auto",
          pipeline: [
            {
              key: "agent",
              type: "agent",
              agent: { instance: "codex_main", model: "gpt-5.5" },
              instruction: { file: "../escape.md" },
            },
          ],
        },
      ],
    });
    const definitionEncoded = encodeWorkflowDefinition(definition);
    const currentRaw = `${encodeWorkflowDefinitionJson(definition)}\n`;
    const currentHash = sha256Hex(currentRaw);
    let writeCount = 0;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId: "project-editor-rpc",
            name: "Unsafe Instruction",
            workflowFilePath: ".t3/boards/unsafe-instruction.json",
            workflowVersionHash: currentHash,
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: (input) =>
          Effect.succeed(
            lintWorkflowDefinition(input.definition, {
              providerInstanceExists: () => true,
              instructionFileExists: () => true,
            }),
          ),
        loadAndRegister: () => Effect.die("loadAndRegister must not run after lint failure"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/editor-rpc-project"),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(currentRaw),
        writeFile: () =>
          Effect.sync(() => {
            writeCount += 1;
            return { relativePath: ".t3/boards/unsafe-instruction.json" };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const saved = yield* invokeWorkflowHandler<{
      readonly ok: false;
      readonly lintErrors: ReadonlyArray<{ readonly code: string; readonly message: string }>;
    }>(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: definitionEncoded,
      expectedVersionHash: currentHash,
    });

    assert.equal(saved.ok, false);
    assert.deepEqual(
      saved.lintErrors.map((error) => error.code),
      ["unsafe_instruction_path"],
    );
    assert.equal(writeCount, 0);
  }),
);

it.effect("workflowRpcHandlers rejects board saves whose derived path is not a board file", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-editor-rpc__unsafe");
    const definition = yield* decodeWorkflowDefinition({
      name: "Unsafe",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const definitionEncoded = encodeWorkflowDefinition(definition);

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId: "project-editor-rpc",
            name: "Unsafe",
            workflowFilePath: ".t3/boards/../unsafe.json",
            workflowVersionHash: "hash-before",
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.die("lintDefinition must not run for unsafe path"),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/editor-rpc-project"),
      },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("readFileString must not run for unsafe path"),
        writeFile: () => Effect.die("writeFile must not run for unsafe path"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const result = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: definitionEncoded,
        expectedVersionHash: "hash-before",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.isTrue(result.cause.toString().includes("not a writable workflow board file"));
    }
  }),
);

it.effect(
  "workflowRpcHandlers round-trips saved board definitions and preserves invalid files",
  () =>
    Effect.gen(function* () {
      const projectId = "project-editor-roundtrip" as ProjectId;
      const boardId = BoardId.make("project-editor-roundtrip__delivery");
      const workspaceRoot = "/tmp/editor-roundtrip-project";
      const workflowFilePath = ".t3/boards/delivery.json";
      const initialDefinition = yield* decodeWorkflowDefinition({
        name: "Round Trip",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      let fileContents = `${encodeWorkflowDefinitionJson(initialDefinition)}\n`;
      const initialHash = sha256Hex(fileContents);
      let registryDefinition = initialDefinition;
      let boardRow = {
        boardId,
        projectId,
        name: registryDefinition.name,
        workflowFilePath,
        workflowVersionHash: initialHash,
        maxConcurrentTickets: 3,
      };

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
          stopAgentSessionsForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          editTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: () => Effect.succeed(boardRow),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(registryDefinition),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
          subscribe: () => Effect.succeed(Stream.empty),
        },
        fileLoader: {
          lintDefinition: (input) =>
            Effect.sync(() =>
              input.definition.lanes.some(
                (lane) => lane.wipLimit !== undefined && lane.wipLimit < 1,
              )
                ? [
                    {
                      code: "invalid_wip_limit" as const,
                      message: "wipLimit must be at least 1",
                      laneKey: "queue",
                    },
                  ]
                : [],
            ),
          loadAndRegister: (input) =>
            Effect.gen(function* () {
              registryDefinition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
                Effect.orDie,
              );
              boardRow = {
                ...boardRow,
                name: registryDefinition.name,
                workflowVersionHash: sha256Hex(fileContents),
              };
              return input.boardId;
            }),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: noopVersionStore,
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed(workspaceRoot),
        },
        workspaceFileSystem: {
          readFile: () => Effect.die("unused"),
          listFiles: () => Effect.succeed([]),
          readFileString: (input: Parameters<WorkspaceFileSystem["Service"]["readFileString"]>[0]) =>
            Effect.sync(() => {
              assert.deepEqual(input, { cwd: workspaceRoot, relativePath: workflowFilePath });
              return fileContents;
            }),
          writeFile: (input: Parameters<WorkspaceFileSystem["Service"]["writeFile"]>[0]) =>
            Effect.sync(() => {
              assert.equal(input.cwd, workspaceRoot);
              assert.equal(input.relativePath, workflowFilePath);
              fileContents = input.contents;
              return { relativePath: input.relativePath };
            }),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () => Effect.die("unused"),
        },
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      const loadedBefore = yield* invokeWorkflowHandler<{
        readonly definition: { readonly name: string };
        readonly versionHash: string;
      }>(handlers, WORKFLOW_WS_METHODS.getBoardDefinition, { boardId });
      assert.equal(loadedBefore.definition.name, "Round Trip");
      assert.equal(loadedBefore.versionHash, initialHash);

      const editedDefinition = yield* decodeWorkflowDefinition({
        name: "Round Trip Edited",
        lanes: [
          { key: "queue", name: "Queue Updated", entry: "manual", wipLimit: 2 },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      const saved = yield* invokeWorkflowHandler<
        | {
            readonly ok: true;
            readonly definition: { readonly name: string };
            readonly versionHash: string;
          }
        | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: encodeWorkflowDefinition(editedDefinition),
        expectedVersionHash: initialHash,
      });
      assert.equal(saved.ok, true);
      if (saved.ok !== true) {
        assert.fail("expected successful save");
      }
      assert.equal(saved.versionHash, sha256Hex(fileContents));

      const loadedAfter = yield* invokeWorkflowHandler<{
        readonly definition: {
          readonly name: string;
          readonly lanes: ReadonlyArray<{ readonly name: string }>;
        };
        readonly versionHash: string;
      }>(handlers, WORKFLOW_WS_METHODS.getBoardDefinition, { boardId });
      assert.equal(loadedAfter.definition.name, "Round Trip Edited");
      assert.equal(loadedAfter.definition.lanes[0]?.name, "Queue Updated");
      assert.equal(loadedAfter.versionHash, saved.versionHash);

      const fileContentsAfterValidSave = fileContents;
      const invalidDefinition = yield* decodeWorkflowDefinition({
        name: "Round Trip Invalid",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual", wipLimit: 0 },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      const rejected = yield* invokeWorkflowHandler<{
        readonly ok: false;
        readonly lintErrors: ReadonlyArray<{ readonly code: string }>;
      }>(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: encodeWorkflowDefinition(invalidDefinition),
        expectedVersionHash: saved.versionHash,
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.lintErrors[0]?.code, "invalid_wip_limit");
      assert.equal(fileContents, fileContentsAfterValidSave);
    }),
);

it.effect(
  "workflowRpcHandlers listNeedsAttentionTickets returns real query rows (not the placeholder [])",
  () =>
    Effect.gen(function* () {
      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
          stopAgentSessionsForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          editTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          listNeedsAttentionTickets: () =>
            Effect.succeed([
              {
                ticketId: "ticket-attention-1",
                boardId: "board-attention-1",
                boardName: "Delivery Board",
                title: "Deploy hotfix",
                status: "waiting_on_user",
                currentLaneKey: "review",
                attentionKind: "waiting_for_input" as const,
                attentionReason: "Please confirm the deploy target",
                updatedAt: "2026-06-13T10:00:00.000Z",
              },
              // A second ticket with status "running" — should NOT appear because the
              // read model filters; we verify the handler passes through exactly what
              // the read model returns (the model already filters), so we give it only
              // the attention row.
            ]),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(null),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
          subscribe: () => Effect.succeed(Stream.empty),
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: () => Effect.die("unused"),
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed("/tmp/project"),
        },
        workspaceFileSystem: {
          readFile: () => Effect.die("unused"),
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.die("unused"),
          writeFile: () => Effect.die("unused"),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () => Effect.die("unused"),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: noopVersionStore,
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      const rows = yield* invokeWorkflowHandler<
        ReadonlyArray<{
          readonly ticketId: string;
          readonly boardName: string;
          readonly attentionKind: string | null;
          readonly attentionReason: string | null;
        }>
      >(handlers, WORKFLOW_WS_METHODS.listNeedsAttentionTickets, {});

      assert.equal(rows.length, 1, "should return the one attention row, not an empty placeholder");
      assert.equal(rows[0]?.ticketId, "ticket-attention-1");
      assert.equal(rows[0]?.boardName, "Delivery Board");
      assert.equal(rows[0]?.attentionKind, "waiting_for_input");
      assert.equal(rows[0]?.attentionReason, "Please confirm the deploy target");
    }),
);

it.effect(
  "workflowRpcHandlers getTicketDetail surfaces attentionKind, attentionReason, and currentLane.actions",
  () =>
    Effect.gen(function* () {
      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
          stopAgentSessionsForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          editTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getTicketDetail: () =>
            Effect.succeed({
              ticket: {
                ticketId: "ticket-detail-attention",
                boardId: "board-detail-1",
                title: "Review PR",
                description: null,
                currentLaneKey: "review",
                currentLaneEntryToken: null,
                queuedAt: null,
                totalTokens: null,
                totalDurationMs: null,
                status: "waiting_on_user",
                attentionKind: "waiting_for_input",
                attentionReason: "Awaiting human review",
                currentLane: {
                  key: "review",
                  name: "Review",
                  actions: [{ label: "Approve", to: "done", hint: "Looks good" }],
                },
              },
              steps: [],
              messages: [],
            } as never),
          listTicketRouteDecisions: () => Effect.succeed([]),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(null),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
          subscribe: () => Effect.succeed(Stream.empty),
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: () => Effect.die("unused"),
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed("/tmp/project"),
        },
        workspaceFileSystem: {
          readFile: () => Effect.die("unused"),
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.die("unused"),
          writeFile: () => Effect.die("unused"),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () => Effect.die("unused"),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: noopVersionStore,
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      const detail = yield* handlers[WORKFLOW_WS_METHODS.getTicketDetail]({
        ticketId: TicketId.make("ticket-detail-attention"),
      });

      assert.equal(
        detail.ticket.attentionKind,
        "waiting_for_input",
        "attentionKind must pass through from read-model row",
      );
      assert.equal(
        detail.ticket.attentionReason,
        "Awaiting human review",
        "attentionReason must pass through from read-model row",
      );
      assert.isDefined(detail.ticket.currentLane, "currentLane must be present in detail view");
      assert.equal(detail.ticket.currentLane?.key, "review");
      assert.equal(detail.ticket.currentLane?.name, "Review");
      assert.equal(detail.ticket.currentLane?.actions.length, 1);
      assert.equal(detail.ticket.currentLane?.actions[0]?.label, "Approve");
      assert.equal(detail.ticket.currentLane?.actions[0]?.to, "done");
      assert.equal(detail.ticket.currentLane?.actions[0]?.hint, "Looks good");
    }),
);

const importNoopEngine = {
  createTicket: () => Effect.die("unused"),
  editTicket: () => Effect.void,
  moveTicket: () => Effect.void,
  createTicketAndEnterUnlocked: () => Effect.die("unused"),
  closeTicketFromSourceUnlocked: () => Effect.die("unused"),
  reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
  cancellableProviderTurnsForTicket: () => Effect.die("unused"),
  supersedeProviderWorkForTicket: () => Effect.die("unused"),
  terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
  stopAgentSessionsForTicket: () => Effect.die("unused"),
  editTicketFieldsUnlocked: () => Effect.die("unused"),
  withBoardAdmissionLock: (_boardId: unknown, effect: unknown) => effect,
  runLane: () => Effect.void,
  ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
  resolveApproval: () => Effect.void,
  answerTicketStep: () => Effect.void,
  postTicketMessage: () => Effect.void,
  editTicketMessage: () => Effect.void,
  cancelStep: () => Effect.void,
  cancelBoardPipelines: () => Effect.void,
  cancelTicketPipelines: () => Effect.void,
  recoverBoardWip: () => Effect.void,
  completeRecoveredStep: () => Effect.void,
} as never;

interface ImportHarnessOptions {
  /** Lint errors returned by fileLoader.lintDefinition (strict import lint). */
  readonly lintErrors?: ReadonlyArray<LintError>;
}

/**
 * Builds a workflow handler set wired with state-tracking fakes for exercising
 * importBoard end-to-end (caps → decode → lint partition → create-from-def).
 *
 * The loadAndRegister fake mimics the real seam: in "strict" mode it throws on
 * env-bound codes, in "skip" mode (what importBoard uses) it registers without
 * re-linting. File writes go through createFileExclusive and are tracked so we
 * can assert no orphan file is left on a blocking-lint rejection.
 */
const makeImportHarness = (projectId: ProjectId, options: ImportHarnessOptions = {}) => {
  const projectRoot = "/tmp/import-project-root";
  const rows = new Map<
    string,
    {
      readonly boardId: string;
      readonly projectId: string;
      readonly name: string;
      readonly workflowFilePath: string;
      readonly workflowVersionHash: string;
      readonly maxConcurrentTickets: number;
    }
  >();
  const definitions = new Map<string, WorkflowDefinitionType>();
  const entries: BoardListEntry[] = [];
  const writes: Array<{
    readonly projectRoot: string;
    readonly relativePath: string;
    readonly contents: string;
  }> = [];
  const deletes: Array<{ readonly cwd: string; readonly relativePath: string }> = [];
  const versionRecords: WorkflowBoardVersionRecordInput[] = [];
  const registerCalls: Array<{ readonly boardId: string; readonly lintMode?: string }> = [];

  const deps = {
    engine: importNoopEngine,
    readModel: {
      ...noopReadModel,
      getBoard: (boardId) => Effect.succeed(rows.get(boardId as string) ?? null),
    },
    boardRegistry: {
      register: () => Effect.die("unused"),
      unregister: () => Effect.void,
      getDefinition: (boardId) => Effect.succeed(definitions.get(boardId as string) ?? null),
      listDefinitions: () => Effect.succeed([]),
      getLane: () => Effect.succeed(null),
    },
    ticketDiff: { getTicketDiff: () => Effect.die("unused") },
    ticketWorktrees: { resolveForTicket: () => Effect.die("unused") },
    boardEvents: {
      publish: () => Effect.void,
      stream: () => Stream.empty,
      subscribe: () => Effect.succeed(Stream.empty),
    },
    fileLoader: {
      lintDefinition: () => Effect.succeed(options.lintErrors ?? []),
      loadAndRegister: (input) =>
        Effect.gen(function* () {
          // Mirror the real loadAndRegister: strict mode would throw on the
          // env-bound codes; skip mode registers regardless.
          if (input.lintMode !== "skip") {
            const offending = (options.lintErrors ?? []).filter(
              (error) =>
                error.code === "unknown_provider_instance" ||
                error.code === "missing_instruction_file",
            );
            if (offending.length > 0) {
              return yield* new WorkflowRpcError({
                message: `Workflow lint failed: ${offending.map((error) => error.code).join(", ")}`,
              });
            }
          }
          registerCalls.push({
            boardId: input.boardId as string,
            ...(input.lintMode === undefined ? {} : { lintMode: input.lintMode }),
          });
          const content = writes.find(
            (write) => write.relativePath === input.relativePath,
          )?.contents;
          const definition = defaultBoardDefinition({
            name: "Imported",
            agent: { instance: "codex_main", model: "gpt-5.5" },
          });
          rows.set(input.boardId as string, {
            boardId: input.boardId,
            projectId: input.projectId,
            name: definition.name,
            workflowFilePath: input.relativePath,
            workflowVersionHash: sha256Hex(content ?? ""),
            maxConcurrentTickets: 3,
          });
          definitions.set(input.boardId as string, definition);
          entries.push({
            boardId: input.boardId,
            name: definition.name,
            filePath: input.relativePath,
            error: null,
          });
          return input.boardId;
        }),
    },
    projectScriptTrust: noopProjectScriptTrust,
    connectionStore: noopConnectionStore,
    versionStore: {
      record: (input) =>
        Effect.sync(() => {
          versionRecords.push(input);
        }),
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(null),
      deleteForBoard: () => Effect.void,
    },
    boardDiscovery: {
      discover: () => Effect.succeed(entries),
      list: () => Effect.succeed(entries),
    },
    projectWorkspaceResolver: { resolve: () => Effect.succeed(projectRoot) },
    workspaceFileSystem: {
      readFile: () => Effect.die("unused"),
      listFiles: () => Effect.succeed([]),
      readFileString: () => Effect.die("unused"),
      writeFile: () => Effect.die("writeFile must not be used"),
      createFileExclusive: (input: Parameters<WorkspaceFileSystem["Service"]["createFileExclusive"]>[0]) =>
        Effect.sync(() => {
          writes.push(input);
          return { relativePath: input.relativePath };
        }),
      deleteFile: (input: Parameters<WorkspaceFileSystem["Service"]["deleteFile"]>[0]) =>
        Effect.sync(() => {
          deletes.push(input);
        }),
    },
    // The createWorkflowBoard dead-end dry-run gate (definition path only) needs
    // a predicate evaluator; the always-false stub means transitions never fire.
    predicates: stubPredicates,
    observeRpcEffect: (_method, effect) => effect,
    observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
  } satisfies Parameters<typeof workflowRpcHandlers>[0];

  const handlers = workflowRpcHandlers(deps);

  return { handlers, deps, projectRoot, writes, deletes, versionRecords, registerCalls };
};

const manualImportDefinition = (name: string): WorkflowDefinitionEncoded =>
  encodeWorkflowDefinition({
    name,
    lanes: [
      { key: LaneKey.make("backlog"), name: "Backlog", entry: "manual" },
      { key: LaneKey.make("done"), name: "Done", entry: "manual" },
    ],
  } satisfies WorkflowDefinitionType);

it.effect("importBoard creates a board from a valid manual definition", () =>
  Effect.gen(function* () {
    const projectId = "import-valid" as ProjectId;
    const harness = makeImportHarness(projectId);

    const result = yield* invokeWorkflowHandler<{
      readonly ok: boolean;
      readonly boardId: string;
      readonly warnings: ReadonlyArray<string>;
    }>(harness.handlers, WORKFLOW_WS_METHODS.importBoard, {
      projectId,
      definition: manualImportDefinition("Imported Flow"),
    });

    assert.equal(result.ok, true);
    assert.equal(result.boardId, `${projectId}__imported-flow`);
    assert.deepEqual(result.warnings, []);
    // Board file was written and registered (permissive, lintMode skip).
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.writes[0]?.relativePath, ".t3/boards/imported-flow.json");
    assert.deepEqual(harness.registerCalls, [
      { boardId: `${projectId}__imported-flow`, lintMode: "skip" },
    ]);
    // "import" version recorded.
    assert.equal(harness.versionRecords.length, 1);
    assert.equal(harness.versionRecords[0]?.source, "import");
    // No orphan cleanup on success.
    assert.deepEqual(harness.deletes, []);
  }),
);

it.effect("importBoard treats an unknown agent instance as a warning, not a blocker", () =>
  Effect.gen(function* () {
    const projectId = "import-envbound" as ProjectId;
    const harness = makeImportHarness(projectId, {
      lintErrors: [
        {
          code: "unknown_provider_instance",
          message: 'Agent instance "ghost" does not exist',
          laneKey: "backlog",
        },
      ],
    });

    const result = yield* invokeWorkflowHandler<{
      readonly ok: boolean;
      readonly boardId: string;
      readonly warnings: ReadonlyArray<string>;
    }>(harness.handlers, WORKFLOW_WS_METHODS.importBoard, {
      projectId,
      definition: manualImportDefinition("Env Bound"),
    });

    assert.equal(result.ok, true, "env-bound lint must not block the import");
    assert.equal(result.boardId, `${projectId}__env-bound`);
    assert.deepEqual(result.warnings, ['Agent instance "ghost" does not exist']);
    // Board WAS created despite the env-bound finding.
    assert.equal(harness.writes.length, 1);
    assert.deepEqual(harness.registerCalls, [
      { boardId: `${projectId}__env-bound`, lintMode: "skip" },
    ]);
  }),
);

it.effect("importBoard blocks a structural lint error and leaves no orphan file", () =>
  Effect.gen(function* () {
    const projectId = "import-structural" as ProjectId;
    const harness = makeImportHarness(projectId, {
      lintErrors: [
        {
          code: "duplicate_lane_key",
          message: 'Duplicate lane key "backlog"',
          laneKey: "backlog",
        },
      ],
    });

    const result = yield* invokeWorkflowHandler<{
      readonly ok: boolean;
      readonly lintErrors: ReadonlyArray<{ readonly code: string }>;
    }>(harness.handlers, WORKFLOW_WS_METHODS.importBoard, {
      projectId,
      definition: manualImportDefinition("Structural"),
    });

    assert.equal(result.ok, false, "structural lint must block the import");
    assert.equal(result.lintErrors.length, 1);
    assert.equal(result.lintErrors[0]?.code, "duplicate_lane_key");
    // No file written → no orphan, and nothing to delete.
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.deletes, []);
    assert.deepEqual(harness.registerCalls, []);
  }),
);

it.effect(
  "importBoard rejects an oversized definition with renderable lintErrors (not RpcError)",
  () =>
    Effect.gen(function* () {
      const projectId = "import-oversized" as ProjectId;
      const harness = makeImportHarness(projectId);
      // Exceed the NEW generous DoS ceiling (MAX_IMPORT_LANES = 1000).
      const oversized = {
        name: "Too Big",
        lanes: Array.from({ length: 1001 }, (_unused, index) => ({
          key: LaneKey.make(`lane-${index}`),
          name: `Lane ${index}`,
          entry: "manual" as const,
        })),
      } satisfies WorkflowDefinitionType;

      // A cap violation is a user-input problem → renderable {ok:false, lintErrors},
      // NOT a transport WorkflowRpcError. The handler must resolve, not fail.
      const result = yield* invokeWorkflowHandler<{
        readonly ok: boolean;
        readonly lintErrors: ReadonlyArray<{ readonly code: string; readonly message: string }>;
      }>(harness.handlers, WORKFLOW_WS_METHODS.importBoard, {
        projectId,
        definition: encodeWorkflowDefinition(oversized),
      });

      assert.equal(result.ok, false, "oversized import must return {ok:false}");
      assert.isTrue(result.lintErrors.length > 0, "oversized import must surface lintErrors");
      assert.equal(result.lintErrors[0]?.code, "invalid_step");
      assert.match(result.lintErrors[0]?.message ?? "", /too large/i);
      assert.deepEqual(harness.writes, []);
    }),
);

it.effect("importBoard imports a large-but-valid board the OLD caps wrongly rejected", () =>
  Effect.gen(function* () {
    // 250 lanes exceeds the OLD MAX_DRY_RUN_LANES (200) but is well within the new
    // generous MAX_IMPORT_LANES (1000). A saved board this size must round-trip.
    const projectId = "import-large-valid" as ProjectId;
    const harness = makeImportHarness(projectId);
    const large = {
      name: "Large Valid",
      lanes: Array.from({ length: 250 }, (_unused, index) => ({
        key: LaneKey.make(`lane-${index}`),
        name: `Lane ${index}`,
        entry: "manual" as const,
      })),
    } satisfies WorkflowDefinitionType;

    const result = yield* invokeWorkflowHandler<{
      readonly ok: boolean;
      readonly boardId: string;
      readonly warnings: ReadonlyArray<string>;
    }>(harness.handlers, WORKFLOW_WS_METHODS.importBoard, {
      projectId,
      definition: encodeWorkflowDefinition(large),
    });

    assert.equal(result.ok, true, "a 250-lane board must import under the new caps");
    assert.equal(result.boardId, `${projectId}__large-valid`);
    assert.equal(harness.writes.length, 1);
  }),
);

it.effect("importBoard does not die (defect) when given a deeply-nested predicate definition", () =>
  Effect.gen(function* () {
    // This test verifies two fixes together:
    // Fix 1: the depth guard in inspectNode catches too-deep predicates as a
    //         blocking lint error (invalid_json_logic) rather than stack-overflowing.
    // Fix 2: importBoard's JSON.stringify size probe is wrapped so a pathologically
    //         deep object cannot produce an unhandled RangeError defect.
    //
    // We use a harness whose lintDefinition calls through to the real
    // lintWorkflowDefinition so the depth guard fires in an integrated path.
    const projectId = "import-deep-predicate" as ProjectId;

    // Build a predicate nested one level beyond the guard (depth > MAX_PREDICATE_DEPTH).
    let deepPredicate: unknown = { var: "pipeline.result" };
    for (let i = 0; i < MAX_PREDICATE_DEPTH + 1; i++) {
      deepPredicate = { "!": deepPredicate };
    }

    const definition = {
      name: "Deep Predicate Board",
      lanes: [
        {
          key: LaneKey.make("impl"),
          name: "Impl",
          entry: "auto" as const,
          pipeline: [{ key: StepKey.make("s"), type: "script" as const, run: "echo ok" }],
          transitions: [{ when: deepPredicate, to: LaneKey.make("done") }],
          on: { success: LaneKey.make("done"), failure: LaneKey.make("done") },
        },
        { key: LaneKey.make("done"), name: "Done", entry: "manual" as const, terminal: true },
      ],
    } as unknown as WorkflowDefinitionType;

    // Override lintDefinition to call through to the real lint (default harness
    // always returns [], which would miss the depth guard test).
    const harness = makeImportHarness(projectId, {
      lintErrors: lintWorkflowDefinition(definition, {
        providerInstanceExists: () => true,
        instructionFileExists: () => true,
      }),
    });

    const encoded = encodeWorkflowDefinition(definition);

    const exit = yield* Effect.exit(
      invokeWorkflowHandler(harness.handlers, WORKFLOW_WS_METHODS.importBoard, {
        projectId,
        definition: encoded,
      }),
    );

    // Must never be a defect (Die / unhandled RangeError).
    if (exit._tag === "Failure") {
      const cause = exit.cause;
      assert.isFalse(
        Cause.hasDies(cause),
        `importBoard must not die on a too-deep predicate; got Die defect`,
      );
      // A clean WorkflowRpcError Fail is also acceptable.
    } else {
      // Resolved means lint blocked it with {ok:false, lintErrors:[...]}.
      const result = exit.value as { ok: boolean; lintErrors?: unknown[] };
      assert.isFalse(
        result.ok,
        "importBoard must return ok:false when lint blocks a too-deep predicate",
      );
      assert.isTrue(
        Array.isArray(result.lintErrors) && result.lintErrors.length > 0,
        "importBoard must surface lint errors for a too-deep predicate",
      );
    }

    // No file written (import was blocked before the write step).
    assert.deepEqual(harness.writes, []);
  }),
);

it.effect("importBoard dedupes the slug for a duplicate board name", () =>
  Effect.gen(function* () {
    const projectId = "import-dupe" as ProjectId;
    const harness = makeImportHarness(projectId);

    const first = yield* invokeWorkflowHandler<{ readonly boardId: string }>(
      harness.handlers,
      WORKFLOW_WS_METHODS.importBoard,
      { projectId, definition: manualImportDefinition("Same Name") },
    );
    const second = yield* invokeWorkflowHandler<{ readonly boardId: string }>(
      harness.handlers,
      WORKFLOW_WS_METHODS.importBoard,
      { projectId, definition: manualImportDefinition("Same Name") },
    );

    assert.equal(first.boardId, `${projectId}__same-name`);
    assert.equal(second.boardId, `${projectId}__same-name-2`);
  }),
);

// ─── validateAndCreateBoard create-mode (vs import-mode) ────────────────────
//
// Task 2 extracts the shared validate-and-create pipeline. import-mode keeps the
// env-bound→warning downgrade; create-mode blocks on EVERY lint error. These
// tests call the shared helper directly with the same harness deps importBoard
// uses, exercising both modes against identical inputs.

it.effect(
  "validateAndCreateBoard create-mode blocks an env-bound lint code that import-mode warns on",
  () =>
    Effect.gen(function* () {
      const projectId = "create-envbound" as ProjectId;
      const harness = makeImportHarness(projectId, {
        lintErrors: [
          {
            code: "unknown_provider_instance",
            message: 'Agent instance "ghost" does not exist',
            laneKey: "backlog",
          },
        ],
      });
      const encodedDefinition = manualImportDefinition("Env Bound Create");

      // import-mode: env-bound finding becomes a warning, board IS created.
      const imported = yield* validateAndCreateBoard(harness.deps, {
        projectId,
        encodedDefinition,
        mode: "import",
      });
      assert.equal(imported.ok, true, "import-mode must downgrade env-bound to a warning");
      assert.isTrue(
        imported.ok && imported.warnings.length > 0,
        "import-mode must surface the env-bound finding as a warning",
      );

      // create-mode: same env-bound finding now BLOCKS — no board written/registered.
      const created = yield* validateAndCreateBoard(harness.deps, {
        projectId,
        encodedDefinition,
        mode: "create",
      });
      assert.equal(created.ok, false, "create-mode must block on the env-bound finding");
      assert.isTrue(
        !created.ok && created.lintErrors.length > 0,
        "create-mode must surface the env-bound finding as a blocking lintError",
      );
      assert.equal(!created.ok && created.lintErrors[0]?.code, "unknown_provider_instance");
      // create-mode wrote NO board file and registered nothing — only import's
      // single create remains on the harness.
      assert.equal(harness.writes.length, 1, "only the import-mode create wrote a file");
      assert.deepEqual(harness.registerCalls, [
        { boardId: `${projectId}__env-bound-create`, lintMode: "skip" },
      ]);
    }),
);

it.effect("validateAndCreateBoard blocks a non-env-bound authoring error in BOTH modes", () =>
  Effect.gen(function* () {
    const projectId = "create-structural" as ProjectId;
    const harness = makeImportHarness(projectId, {
      lintErrors: [
        {
          code: "missing_lane_ref",
          message: 'Transition target lane "ghost" does not exist',
          laneKey: "backlog",
        },
      ],
    });
    const encodedDefinition = manualImportDefinition("Structural Both");

    const imported = yield* validateAndCreateBoard(harness.deps, {
      projectId,
      encodedDefinition,
      mode: "import",
    });
    assert.equal(imported.ok, false, "non-env-bound error must block import-mode");
    assert.equal(imported.ok ? undefined : imported.lintErrors[0]?.code, "missing_lane_ref");

    const created = yield* validateAndCreateBoard(harness.deps, {
      projectId,
      encodedDefinition,
      mode: "create",
    });
    assert.equal(created.ok, false, "non-env-bound error must block create-mode");
    assert.equal(created.ok ? undefined : created.lintErrors[0]?.code, "missing_lane_ref");

    // Neither mode wrote a board file.
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.registerCalls, []);
  }),
);

it.effect("validateAndCreateBoard rejects an oversized definition in BOTH modes", () =>
  Effect.gen(function* () {
    const projectId = "create-oversized" as ProjectId;
    const harness = makeImportHarness(projectId);
    const oversized = {
      name: "Too Big",
      lanes: Array.from({ length: 1001 }, (_unused, index) => ({
        key: LaneKey.make(`lane-${index}`),
        name: `Lane ${index}`,
        entry: "manual" as const,
      })),
    } satisfies WorkflowDefinitionType;
    const encodedDefinition = encodeWorkflowDefinition(oversized);

    const imported = yield* validateAndCreateBoard(harness.deps, {
      projectId,
      encodedDefinition,
      mode: "import",
    });
    assert.equal(imported.ok, false, "oversized import must return {ok:false}");
    assert.equal(imported.ok ? undefined : imported.lintErrors[0]?.code, "invalid_step");

    const created = yield* validateAndCreateBoard(harness.deps, {
      projectId,
      encodedDefinition,
      mode: "create",
    });
    assert.equal(created.ok, false, "oversized create must return {ok:false}");
    assert.equal(created.ok ? undefined : created.lintErrors[0]?.code, "invalid_step");

    assert.deepEqual(harness.writes, []);
  }),
);

// ─── createWorkflowBoard (Create Workflow Wizard, Task 5) ───────────────────
//
// The wizard handler builds an encoded definition per choice.kind and routes it
// through the SAME create-mode validateAndCreateBoard pipeline. Empty/template
// build a definition locally; definition passes the raw client payload straight
// to the helper (which re-validates). Result shape is {ok:true, boardId} (NO
// warnings) | {ok:false, lintErrors, message?}.

const wizardAgent = { instance: "codex_main", model: "gpt-5.5" } as const;

it.effect("createWorkflowBoard creates an empty board from emptyBoardDefinition", () =>
  Effect.gen(function* () {
    const projectId = "wizard-empty" as ProjectId;
    const harness = makeImportHarness(projectId);

    const result = yield* createWorkflowBoard(harness.deps, {
      projectId,
      name: "Empty Wizard" as never,
      choice: { kind: "empty" },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.boardId : undefined, `${projectId}__empty-wizard`);
    // Success shape carries NO warnings key (contract result has no warnings).
    assert.isFalse("warnings" in result, "create result must not carry warnings");
    // Board file written + registered via create-mode (lintMode skip after lint).
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.writes[0]?.relativePath, ".t3/boards/empty-wizard.json");
    // The written definition is the empty board (3 manual lanes).
    const written = yield* decodeWorkflowDefinitionJson(harness.writes[0]!.contents);
    assert.equal(written.lanes.length, 3);
    assert.deepEqual(
      written.lanes.map((lane) => lane.key),
      ["to-do", "in-progress", "done"],
    );
    // "create" version recorded.
    assert.equal(harness.versionRecords.length, 1);
    assert.equal(harness.versionRecords[0]?.source, "create");
    assert.deepEqual(harness.deletes, []);
  }),
);

it.effect("createWorkflowBoard creates a template board with the agent threaded", () =>
  Effect.gen(function* () {
    const projectId = "wizard-template" as ProjectId;
    const harness = makeImportHarness(projectId);

    const result = yield* createWorkflowBoard(harness.deps, {
      projectId,
      name: "Lite Loop" as never,
      choice: { kind: "template", templateId: "lite-agent-loop", agent: wizardAgent },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.boardId : undefined, `${projectId}__lite-loop`);
    assert.equal(harness.writes.length, 1);
    // The lite-agent-loop template threads the agent into its pipeline steps.
    const written = yield* decodeWorkflowDefinitionJson(harness.writes[0]!.contents);
    const inProgress = written.lanes.find((lane) => lane.key === "in-progress");
    assert.isDefined(inProgress?.pipeline);
    const implement = inProgress?.pipeline?.find((step) => step.key === "implement");
    assert.deepEqual(implement?.type === "agent" ? implement.agent : undefined, {
      instance: wizardAgent.instance,
      model: wizardAgent.model,
    });
    assert.equal(harness.versionRecords[0]?.source, "create");
  }),
);

it.effect("createWorkflowBoard rejects a requiresAgent template with no agent (no board)", () =>
  Effect.gen(function* () {
    const projectId = "wizard-template-noagent" as ProjectId;
    const harness = makeImportHarness(projectId);

    const result = yield* createWorkflowBoard(harness.deps, {
      projectId,
      name: "Needs Agent" as never,
      choice: { kind: "template", templateId: "full-sdlc" },
    });

    assert.equal(result.ok, false);
    assert.isTrue(!result.ok && typeof result.message === "string" && result.message.length > 0);
    assert.deepEqual(!result.ok ? result.lintErrors : [null], []);
    // No board written/registered: the agent check is BEFORE any build/create.
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.registerCalls, []);
    assert.deepEqual(harness.versionRecords, []);
  }),
);

it.effect("createWorkflowBoard rejects an unknown templateId (no board)", () =>
  Effect.gen(function* () {
    const projectId = "wizard-template-unknown" as ProjectId;
    const harness = makeImportHarness(projectId);

    const result = yield* createWorkflowBoard(harness.deps, {
      projectId,
      name: "Ghost Template" as never,
      choice: { kind: "template", templateId: "does-not-exist", agent: wizardAgent },
    });

    assert.equal(result.ok, false);
    assert.isTrue(
      !result.ok && typeof result.message === "string" && /unknown template/i.test(result.message),
    );
    assert.deepEqual(!result.ok ? result.lintErrors : [null], []);
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.registerCalls, []);
  }),
);

it.effect("createWorkflowBoard creates a board from a valid client definition", () =>
  Effect.gen(function* () {
    const projectId = "wizard-definition" as ProjectId;
    const harness = makeImportHarness(projectId);

    const result = yield* createWorkflowBoard(harness.deps, {
      projectId,
      name: "From Def" as never,
      choice: {
        kind: "definition",
        definition: manualImportDefinition("Authored Board"),
      },
    });

    assert.equal(result.ok, true);
    // Slug derives from the DEFINITION name (validateAndCreateBoard uses the
    // decoded definition's name), not the wizard input.name.
    assert.equal(result.ok ? result.boardId : undefined, `${projectId}__authored-board`);
    assert.isFalse("warnings" in result, "create result must not carry warnings");
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.versionRecords[0]?.source, "create");
  }),
);

it.effect("createWorkflowBoard blocks a definition that fails strict lint (no board)", () =>
  Effect.gen(function* () {
    const projectId = "wizard-definition-lint" as ProjectId;
    // A transition target referencing a missing lane → blocking lint in create-mode.
    const harness = makeImportHarness(projectId, {
      lintErrors: [
        {
          code: "missing_lane_ref",
          message: 'Transition target lane "ghost" does not exist',
          laneKey: "backlog",
        },
      ],
    });

    const result = yield* createWorkflowBoard(harness.deps, {
      projectId,
      name: "Bad Def" as never,
      choice: {
        kind: "definition",
        definition: manualImportDefinition("Bad Authored Board"),
      },
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok ? result.lintErrors[0]?.code : undefined, "missing_lane_ref");
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.registerCalls, []);
  }),
);

it.effect("createWorkflowBoard rejects an oversized client definition (no board)", () =>
  Effect.gen(function* () {
    const projectId = "wizard-definition-oversized" as ProjectId;
    const harness = makeImportHarness(projectId);
    const oversized = {
      name: "Too Big",
      lanes: Array.from({ length: 1001 }, (_unused, index) => ({
        key: LaneKey.make(`lane-${index}`),
        name: `Lane ${index}`,
        entry: "manual" as const,
      })),
    } satisfies WorkflowDefinitionType;

    const result = yield* createWorkflowBoard(harness.deps, {
      projectId,
      name: "Oversized" as never,
      choice: { kind: "definition", definition: encodeWorkflowDefinition(oversized) },
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok ? result.lintErrors[0]?.code : undefined, "invalid_step");
    assert.deepEqual(harness.writes, []);
  }),
);

it.effect(
  "createWorkflowBoard rejects a stranding client definition via the dry-run gate (no board)",
  () =>
    Effect.gen(function* () {
      const projectId = "wizard-definition-strands" as ProjectId;
      const harness = makeImportHarness(projectId);
      // `build` is an auto lane whose only step has no step.on routing and the
      // lane has no transitions / lane.on → dry run ends in no_route (strands
      // tickets). A terminal `done` lane exists so lint would pass; only the
      // dead-end dry-run gate (definition path) catches it — and BEFORE any write.
      const strandingDef = encodeWorkflowDefinition({
        name: "Stranding Authored Board",
        lanes: [
          { key: LaneKey.make("backlog"), name: "Backlog", entry: "manual" },
          {
            key: LaneKey.make("build"),
            name: "Build",
            entry: "auto",
            pipeline: [
              {
                key: StepKey.make("implement"),
                type: "agent",
                agent: { instance: "codex_main", model: "gpt-5.5" },
                instruction: "do work",
              },
            ],
          },
          { key: LaneKey.make("done"), name: "Done", entry: "auto", terminal: true },
        ],
      } satisfies WorkflowDefinitionType);

      const result = yield* createWorkflowBoard(harness.deps, {
        projectId,
        name: "Strands" as never,
        choice: { kind: "definition", definition: strandingDef },
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) assert.fail("expected ok:false");
      // The dead-end dry-run now runs as validateAndCreateBoard's afterLint hook
      // (AFTER caps + decode + lint), so the stranding message renders through a
      // single "invalid_step" lintError (the only failure shape the import helper
      // can return), not via a separate top-level `message`.
      assert.equal(result.lintErrors.length, 1);
      assert.equal(result.lintErrors[0]?.code, "invalid_step");
      assert.include(result.lintErrors[0]?.message ?? "", "strands tickets");
      assert.include(result.lintErrors[0]?.message ?? "", "build");
      // Nothing persisted: the afterLint gate returns ok:false BEFORE persist.
      assert.deepEqual(harness.writes, []);
      assert.deepEqual(harness.registerCalls, []);
      assert.deepEqual(harness.versionRecords, []);
    }),
);

it.effect(
  "createWorkflowBoard rejects an oversized definition WITHOUT running the dead-end dry-run (caps before dry-run)",
  () =>
    Effect.gen(function* () {
      const projectId = "wizard-definition-oversized-ordering" as ProjectId;
      const harness = makeImportHarness(projectId);
      // Spy predicate evaluator: the dead-end dry-run is the ONLY caller of
      // `evaluate` on this path. An oversized def must be rejected by the caps in
      // validateAndCreateBoard BEFORE the (bounded) afterLint dry-run could run,
      // so `evaluate` must be invoked ZERO times.
      let evaluateCalls = 0;
      const spyPredicates = {
        evaluate: () => {
          evaluateCalls += 1;
          return Effect.succeed({ result: false, matchedPaths: [] });
        },
      };
      const deps = { ...harness.deps, predicates: spyPredicates };
      // > MAX_IMPORT_LANES (1000) AND every lane is an auto lane with no pipeline,
      // so a dead-end dry-run (if it ran first) WOULD strand every lane
      // (`no_route`). The fix guarantees the caps reject the def FIRST → the
      // rejection is the "too large" caps message, never the stranding message.
      const oversized = {
        name: "Too Big",
        lanes: Array.from({ length: 1001 }, (_unused, index) => ({
          key: LaneKey.make(`lane-${index}`),
          name: `Lane ${index}`,
          entry: "auto" as const,
        })),
      } satisfies WorkflowDefinitionType;

      const result = yield* createWorkflowBoard(deps, {
        projectId,
        name: "Oversized" as never,
        choice: { kind: "definition", definition: encodeWorkflowDefinition(oversized) },
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) assert.fail("expected ok:false");
      // Rejected by the caps (the "too large" lint message), NOT the stranding msg.
      assert.equal(result.lintErrors[0]?.code, "invalid_step");
      assert.match(result.lintErrors[0]?.message ?? "", /too large/i);
      assert.notInclude(result.lintErrors[0]?.message ?? "", "strands tickets");
      // The dead-end dry-run never ran: caps fired first.
      assert.equal(evaluateCalls, 0, "dead-end dry-run must NOT run on an oversized def");
      assert.deepEqual(harness.writes, []);
      assert.deepEqual(harness.registerCalls, []);
    }),
);

// ─── proposeBoardImprovement (self-improve E4) ──────────────────────────────

const proposalBoardId = BoardId.make("board-propose");
const proposalAgent = { instance: "claude_main", model: "sonnet" } as const;

// backlog (manual) → work (auto; step.on success → done) → done (terminal)
const proposalBaseDefinition = {
  name: "Self-improve board",
  sources: [],
  outbound: [],
  lanes: [
    { key: LaneKey.make("backlog"), name: "Backlog", entry: "manual" },
    {
      key: LaneKey.make("work"),
      name: "Work",
      entry: "auto",
      pipeline: [
        {
          key: StepKey.make("code"),
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do the work",
          on: {
            success: LaneKey.make("done"),
            failure: LaneKey.make("done"),
            blocked: LaneKey.make("done"),
          },
        },
      ],
    },
    { key: LaneKey.make("done"), name: "Done", entry: "auto", terminal: true },
  ],
} satisfies WorkflowDefinitionType;

const proposalMetrics = {
  windowDays: 30,
  generatedAt: "2026-06-14T00:00:00.000Z",
  throughput: { created: 3, shipped: 2 },
  cycleTime: { count: 2, p50Ms: 100, p90Ms: 200, avgMs: 150 },
  wipByLane: [],
  statusBreakdown: {},
  attention: { blocked: 0, waitingOnUser: 0, oldest: [] },
  routeOutcomes: [],
  manualMoveCount: 0,
  stepStats: [],
} as const;

const stubPredicates = {
  evaluate: () => Effect.succeed({ result: false, matchedPaths: [] }),
};

interface ProposalGenResult {
  readonly proposedDefinition: unknown;
  readonly rationale: string;
}

const makeProposeDeps = (args: {
  readonly gen: () => Effect.Effect<ProposalGenResult, TextGenerationError>;
  readonly lint?: () => Effect.Effect<ReadonlyArray<LintError>, WorkflowRpcError>;
  readonly recorded: Array<unknown>;
}) => ({
  readModel: {
    ...noopReadModel,
    getBoard: () =>
      Effect.succeed({
        boardId: proposalBoardId,
        projectId: "project-1",
        name: "Self-improve board",
        workflowFilePath: ".t3/boards/self-improve.json",
        workflowVersionHash: "base-hash-123",
        maxConcurrentTickets: 2,
      }),
    getBoardMetrics: () => Effect.succeed(proposalMetrics),
    recordBoardProposal: (proposal: unknown) =>
      Effect.sync(() => {
        args.recorded.push(proposal);
      }),
  },
  boardRegistry: {
    register: () => Effect.die("unused"),
    unregister: () => Effect.void,
    getDefinition: () => Effect.succeed(proposalBaseDefinition),
    listDefinitions: () => Effect.succeed([]),
    getLane: () => Effect.succeed(null),
  },
  fileLoader: {
    lintDefinition: args.lint ?? (() => Effect.succeed([])),
    loadAndRegister: () => Effect.die("unused"),
  },
  projectWorkspaceResolver: { resolve: () => Effect.succeed("/tmp/project") },
  predicates: stubPredicates,
  textGeneration: { generateBoardProposal: args.gen },
});

it.effect("proposeBoardImprovement stores a pending proposal when all gates pass", () =>
  Effect.gen(function* () {
    const recorded: Array<unknown> = [];
    // A clean targeted change: rename a lane only.
    const proposed = {
      ...proposalBaseDefinition,
      lanes: proposalBaseDefinition.lanes.map((lane) =>
        (lane.key as string) === "work" ? { ...lane, name: "Work (revised)" } : lane,
      ),
    };
    const deps = makeProposeDeps({
      recorded,
      gen: () =>
        Effect.succeed({ proposedDefinition: proposed, rationale: "renamed the work lane" }),
    });

    const { proposal } = yield* proposeBoardImprovement(deps, {
      boardId: proposalBoardId,
      agent: proposalAgent,
    });

    assert.equal(proposal.status, "pending");
    assert.isTrue(proposal.validation.preservationOk);
    assert.isTrue(proposal.validation.lintOk);
    assert.isTrue(proposal.validation.dryRunOk);
    assert.equal(proposal.baseVersionHash, "base-hash-123");
    assert.isFalse(proposal.outdated);
    assert.equal(proposal.appliedVersionHash, null);
    assert.equal(recorded.length, 1);
    const row = recorded[0] as {
      readonly status: string;
      readonly baseVersionHash: string;
      readonly baseDefJson: string;
      readonly agentJson: string;
    };
    assert.equal(row.status, "pending");
    assert.equal(row.baseVersionHash, "base-hash-123");
    assert.include(row.baseDefJson, "Self-improve board");
    assert.include(row.agentJson, "claude_main");
  }),
);

it.effect(
  "proposeBoardImprovement → invalid when the proposal changes sources (preservation)",
  () =>
    Effect.gen(function* () {
      const recorded: Array<unknown> = [];
      const proposed = {
        ...proposalBaseDefinition,
        sources: [
          {
            id: "src-1",
            provider: "github",
            connectionRef: "conn-1",
            selector: {},
            destinationLane: LaneKey.make("backlog"),
            closedLane: LaneKey.make("done"),
            enabled: true,
          },
        ],
      };
      const deps = makeProposeDeps({
        recorded,
        gen: () => Effect.succeed({ proposedDefinition: proposed, rationale: "add a source" }),
      });

      const { proposal } = yield* proposeBoardImprovement(deps, {
        boardId: proposalBoardId,
        agent: proposalAgent,
      });

      assert.equal(proposal.status, "invalid");
      assert.isFalse(proposal.validation.preservationOk);
      assert.isTrue(proposal.validation.messages.some((m) => m.includes("sources")));
      assert.equal((recorded[0] as { readonly status: string }).status, "invalid");
    }),
);

it.effect("proposeBoardImprovement → invalid when the proposal REMOVES a lane (preservation)", () =>
  Effect.gen(function* () {
    const recorded: Array<unknown> = [];
    // Drop the `work` lane entirely. Routing INTO it would be caught by dry-run,
    // but the removed lane's OWN startLane combos vanish from proposedResults —
    // the preservation lane-key superset gate is what closes this.
    const proposed = {
      ...proposalBaseDefinition,
      lanes: proposalBaseDefinition.lanes.filter((lane) => (lane.key as string) !== "work"),
    };
    const deps = makeProposeDeps({
      recorded,
      gen: () => Effect.succeed({ proposedDefinition: proposed, rationale: "drop a lane" }),
    });

    const { proposal } = yield* proposeBoardImprovement(deps, {
      boardId: proposalBoardId,
      agent: proposalAgent,
    });

    assert.equal(proposal.status, "invalid");
    assert.isFalse(proposal.validation.preservationOk);
    assert.isTrue(
      proposal.validation.messages.some((m) => m.includes("removes/renames") && m.includes("work")),
    );
    // No saveBoardDefinition path exists in deps; the only write is the proposal row.
    assert.equal(recorded.length, 1);
    assert.equal((recorded[0] as { readonly status: string }).status, "invalid");
  }),
);

it.effect("proposeBoardImprovement → invalid when the proposed definition fails strict lint", () =>
  Effect.gen(function* () {
    const recorded: Array<unknown> = [];
    const proposed = {
      ...proposalBaseDefinition,
      lanes: proposalBaseDefinition.lanes.map((lane) =>
        (lane.key as string) === "work" ? { ...lane, name: "Work (revised)" } : lane,
      ),
    };
    const deps = makeProposeDeps({
      recorded,
      gen: () => Effect.succeed({ proposedDefinition: proposed, rationale: "tweak" }),
      lint: () =>
        Effect.succeed([
          { code: "missing_lane_ref", message: "lane target missing" } satisfies LintError,
        ]),
    });

    const { proposal } = yield* proposeBoardImprovement(deps, {
      boardId: proposalBoardId,
      agent: proposalAgent,
    });

    assert.equal(proposal.status, "invalid");
    assert.isTrue(proposal.validation.preservationOk);
    assert.isFalse(proposal.validation.lintOk);
    assert.equal(proposal.validation.lintErrors.length, 1);
  }),
);

it.effect(
  "proposeBoardImprovement → invalid when the proposal introduces a new dead end (dry-run)",
  () =>
    Effect.gen(function* () {
      const recorded: Array<unknown> = [];
      // Drop the step.on routing from `work` so the auto lane ends in no_route.
      const proposed = {
        ...proposalBaseDefinition,
        lanes: proposalBaseDefinition.lanes.map((lane) =>
          (lane.key as string) === "work"
            ? {
                key: LaneKey.make("work"),
                name: "Work",
                entry: "auto",
                pipeline: [
                  {
                    key: StepKey.make("code"),
                    type: "agent",
                    agent: { instance: "claude_main", model: "sonnet" },
                    instruction: "do the work",
                  },
                ],
              }
            : lane,
        ),
      };
      const deps = makeProposeDeps({
        recorded,
        gen: () => Effect.succeed({ proposedDefinition: proposed, rationale: "remove routing" }),
      });

      const { proposal } = yield* proposeBoardImprovement(deps, {
        boardId: proposalBoardId,
        agent: proposalAgent,
      });

      assert.equal(proposal.status, "invalid");
      assert.isTrue(proposal.validation.preservationOk);
      assert.isTrue(proposal.validation.lintOk);
      assert.isFalse(proposal.validation.dryRunOk);
      assert.isTrue(proposal.validation.dryRunRegressions.length > 0);
    }),
);

it.effect(
  "proposeBoardImprovement → invalid (decode) when the proposed definition is malformed",
  () =>
    Effect.gen(function* () {
      const recorded: Array<unknown> = [];
      const deps = makeProposeDeps({
        recorded,
        gen: () =>
          Effect.succeed({ proposedDefinition: { not: "a workflow def" }, rationale: "broken" }),
      });

      const { proposal } = yield* proposeBoardImprovement(deps, {
        boardId: proposalBoardId,
        agent: proposalAgent,
      });

      assert.equal(proposal.status, "invalid");
      assert.isTrue(proposal.validation.messages.some((m) => m.includes("decoded")));
    }),
);

it.effect("proposeBoardImprovement → invalid when generation fails", () =>
  Effect.gen(function* () {
    const recorded: Array<unknown> = [];
    const deps = makeProposeDeps({
      recorded,
      gen: () =>
        Effect.fail(
          new TextGenerationError({ operation: "generateBoardProposal", detail: "provider down" }),
        ),
    });

    const { proposal } = yield* proposeBoardImprovement(deps, {
      boardId: proposalBoardId,
      agent: proposalAgent,
    });

    assert.equal(proposal.status, "invalid");
    assert.include(proposal.rationale, "generation failed");
    assert.equal((recorded[0] as { readonly status: string }).status, "invalid");
  }),
);

// ─── listBoardProposals + getBoardProposal (self-improve E5) ─────────────────

const stubProposalView = (
  overrides?: Partial<{
    proposalId: string;
    boardId: BoardId;
    status: "pending" | "approved" | "rejected" | "superseded" | "invalid" | "reverted";
    outdated: boolean;
  }>,
) => ({
  proposalId: "prop-e5-1",
  boardId: proposalBoardId,
  status: "pending" as const,
  rationale: "stub rationale",
  validation: {
    preservationOk: true,
    lintOk: true,
    dryRunOk: true,
    laneDiffCount: 1,
    lintErrors: [],
    dryRunRegressions: [],
    messages: [],
  },
  baseVersionHash: "base-hash-123",
  appliedVersionHash: null,
  outdated: false,
  agent: proposalAgent,
  createdAt: "2026-06-14T10:00:00.000Z",
  resolvedAt: null,
  ...overrides,
});

it.effect("listBoardProposals handler returns proposals from readModel", () =>
  Effect.gen(function* () {
    const p1 = stubProposalView({ proposalId: "prop-1", outdated: false });
    const p2 = stubProposalView({ proposalId: "prop-2", outdated: true });
    const deps = {
      readModel: {
        ...noopReadModel,
        listBoardProposals: (_boardId: BoardId) => Effect.succeed([p1, p2]),
      },
      observeRpcEffect: <A, E, R>(_method: string, effect: Effect.Effect<A, E, R>) => effect,
    };
    const result = yield* listBoardProposals(deps, { boardId: proposalBoardId });
    assert.equal(result.proposals.length, 2);
    assert.equal(result.proposals[0]?.proposalId, "prop-1");
    assert.equal(result.proposals[0]?.outdated, false);
    assert.equal(result.proposals[1]?.proposalId, "prop-2");
    assert.equal(result.proposals[1]?.outdated, true);
  }),
);

it.effect("listBoardProposals handler returns empty array when no proposals", () =>
  Effect.gen(function* () {
    const deps = {
      readModel: {
        ...noopReadModel,
        listBoardProposals: (_boardId: BoardId) => Effect.succeed([]),
      },
      observeRpcEffect: <A, E, R>(_method: string, effect: Effect.Effect<A, E, R>) => effect,
    };
    const result = yield* listBoardProposals(deps, { boardId: proposalBoardId });
    assert.equal(result.proposals.length, 0);
  }),
);

it.effect("getBoardProposal handler returns proposal + both defs", () =>
  Effect.gen(function* () {
    const view = stubProposalView();
    const proposedDef = encodeWorkflowDefinition(proposalBaseDefinition);
    const baseDef = encodeWorkflowDefinition(proposalBaseDefinition);
    const deps = {
      readModel: {
        ...noopReadModel,
        getBoardProposal: (_proposalId: string) =>
          Effect.succeed({
            view,
            proposedDefinition: proposedDef,
            baseDefinition: baseDef,
          }),
      },
      observeRpcEffect: <A, E, R>(_method: string, effect: Effect.Effect<A, E, R>) => effect,
    };
    const result = yield* getBoardProposal(deps, { proposalId: "prop-e5-1" });
    assert.equal(result.proposal.proposalId, "prop-e5-1");
    assert.equal(result.proposal.outdated, false);
    assert.deepEqual(result.proposedDefinition, proposedDef);
    assert.deepEqual(result.baseDefinition, baseDef);
  }),
);

it.effect("getBoardProposal handler fails with WorkflowRpcError when not found", () =>
  Effect.gen(function* () {
    const deps = {
      readModel: {
        ...noopReadModel,
        getBoardProposal: (_proposalId: string) => Effect.succeed(null),
      },
      observeRpcEffect: <A, E, R>(_method: string, effect: Effect.Effect<A, E, R>) => effect,
    };
    const exit = yield* getBoardProposal(deps, { proposalId: "does-not-exist" }).pipe(Effect.exit);
    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.isTrue(exit.cause.toString().includes("was not found"));
    }
  }),
);

// ─── resolveBoardProposal (self-improve E6) ─────────────────────────────────

// backlog (manual) → work (auto; step.on → done) → done (terminal)
const resolveBaseDefinition = {
  name: "Self-improve resolve board",
  lanes: [
    { key: LaneKey.make("backlog"), name: "Backlog", entry: "manual" },
    {
      key: LaneKey.make("work"),
      name: "Work",
      entry: "auto",
      pipeline: [
        {
          key: StepKey.make("code"),
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do the work",
          on: {
            success: LaneKey.make("done"),
            failure: LaneKey.make("done"),
            blocked: LaneKey.make("done"),
          },
        },
      ],
    },
    { key: LaneKey.make("done"), name: "Done", entry: "auto", terminal: true },
  ],
} satisfies WorkflowDefinitionType;

// A proposal that only renames the `backlog` lane — changes the backlog lane def.
const resolveProposedDefinition = {
  ...resolveBaseDefinition,
  lanes: resolveBaseDefinition.lanes.map((lane) =>
    (lane.key as string) === "backlog" ? { ...lane, name: "Inbox" } : lane,
  ),
} satisfies WorkflowDefinitionType;

interface ResolveHarness {
  readonly recorded: Array<{
    readonly proposalId: string;
    readonly status: string;
    readonly resolvedAt: string;
    readonly appliedVersionHash?: string | null;
    readonly fromStatus?: string;
  }>;
  readonly writes: Array<string>;
  // Order trace: "lock" entries record entry/exit of withBoardAdmissionLock, and
  // "write" records the board-file write — proves the write happened inside the lock.
  readonly trace: Array<string>;
  readonly deps: Parameters<typeof resolveBoardProposal>[0];
}

const makeResolveHarness = (args: {
  readonly versionStore: WorkflowBoardVersionStore["Service"];
  readonly proposalStatus?: "pending" | "approved" | "rejected" | "superseded" | "invalid";
  readonly proposedDefinition?: WorkflowDefinitionType;
  readonly baseDefinition?: WorkflowDefinitionType;
  readonly outdated?: boolean;
  readonly liveOccupiedLanes?: ReadonlyArray<string>;
  readonly lint?: () => Effect.Effect<ReadonlyArray<LintError>, never>;
  // The board's current on-disk hash drives saveBoardDefinition's optimistic
  // concurrency. When it differs from the proposal base hash, save → conflict.
  readonly currentFileMatchesBase?: boolean;
  // Predicate evaluator for the apply-time dry-run re-validation. Defaults to the
  // always-false stub. Omit to skip dry-run (predicates undefined).
  readonly predicates?: typeof stubPredicates | null;
  // Affected-row count returned by the guarded (fromStatus-bearing) status flip.
  // Default 1. Set 0 to simulate a concurrent reject/supersede that raced the
  // pending→approved flip — exercises the reconciliation forced write.
  readonly guardedStatusAffected?: number;
}): ResolveHarness => {
  const boardId = BoardId.make("project-resolve__board");
  const projectId = "project-resolve" as ProjectId;
  const workflowFilePath = ".t3/boards/resolve.json";
  const workspaceRoot = "/tmp/project-resolve-root";

  const baseDef = args.baseDefinition ?? resolveBaseDefinition;
  const proposedDef = args.proposedDefinition ?? resolveProposedDefinition;

  // The on-disk file. By default it equals the proposal base def, so its hash
  // equals the proposal base hash → save passes the concurrency check.
  let fileContents = `${encodeWorkflowDefinitionJson(decodeWorkflowDefinitionSync(baseDef))}\n`;
  const baseHash = sha256Hex(fileContents);
  if (args.currentFileMatchesBase === false) {
    fileContents = `${encodeWorkflowDefinitionJson(decodeWorkflowDefinitionSync({ ...baseDef, name: "Drifted" }))}\n`;
  }
  let registryDefinition = decodeWorkflowDefinitionSync(baseDef);
  let boardRow = {
    boardId,
    projectId,
    name: registryDefinition.name,
    workflowFilePath,
    workflowVersionHash: sha256Hex(fileContents),
    maxConcurrentTickets: 3,
  };

  const proposalView = stubProposalView({
    proposalId: "prop-e6-1",
    boardId,
    status: args.proposalStatus ?? "pending",
    outdated: args.outdated ?? false,
  });
  // baseVersionHash on the view must match the on-disk base hash so a clean
  // approve passes saveBoardDefinition's expectedVersionHash check.
  const view = { ...proposalView, baseVersionHash: baseHash };

  const recorded: ResolveHarness["recorded"] = [];
  const writes: Array<string> = [];
  const trace: Array<string> = [];

  const deps = {
    engine: {
      withBoardAdmissionLock: <A, E, R>(_boardId: BoardId, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          trace.push("lock:enter");
          const result = yield* effect;
          trace.push("lock:exit");
          return result;
        }),
    },
    predicates: args.predicates === null ? undefined : (args.predicates ?? stubPredicates),
    readModel: {
      ...noopReadModel,
      getBoard: (inputBoardId: BoardId) =>
        Effect.succeed(inputBoardId === boardId ? boardRow : null),
      getBoardProposal: (_proposalId: string) =>
        Effect.succeed({
          view,
          proposedDefinition: encodeWorkflowDefinition(decodeWorkflowDefinitionSync(proposedDef)),
          baseDefinition: encodeWorkflowDefinition(decodeWorkflowDefinitionSync(baseDef)),
        }),
      listLiveOccupiedLanes: (_boardId: BoardId) => Effect.succeed(args.liveOccupiedLanes ?? []),
      resolveBoardProposalStatus: (input: {
        proposalId: string;
        status: string;
        resolvedAt: string;
        appliedVersionHash?: string | null;
        fromStatus?: string;
      }) =>
        Effect.sync(() => {
          recorded.push(input);
          // Guarded flips (fromStatus present) can be made to "lose" a race by
          // returning 0; unguarded (forced reconcile) flips always affect 1.
          if (input.fromStatus !== undefined && args.guardedStatusAffected !== undefined) {
            return args.guardedStatusAffected;
          }
          return 1;
        }),
      listWorkSourceMappingsForBoard: () => Effect.succeed([]),
    },
    boardRegistry: {
      register: () => Effect.die("unused"),
      unregister: () => Effect.void,
      getDefinition: () => Effect.succeed(registryDefinition),
      listDefinitions: () => Effect.succeed([]),
      getLane: () => Effect.succeed(null),
    },
    projectWorkspaceResolver: {
      resolve: () => Effect.succeed(workspaceRoot),
    },
    fileLoader: {
      lintDefinition: args.lint ?? (() => Effect.succeed([])),
      loadAndRegister: (input: { readonly boardId: BoardId }) =>
        Effect.gen(function* () {
          const definition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
            Effect.mapError(
              (cause) => new WorkflowRpcError({ message: "round-trip decode failed", cause }),
            ),
          );
          registryDefinition = definition;
          boardRow = {
            ...boardRow,
            name: definition.name,
            workflowVersionHash: sha256Hex(fileContents),
          };
          return input.boardId;
        }),
    },
    workspaceFileSystem: {
      readFile: () => Effect.die("unused"),
      listFiles: () => Effect.succeed([]),
      readFileString: () => Effect.succeed(fileContents),
      writeFile: (input: { readonly relativePath: string; readonly contents: string }) =>
        Effect.sync(() => {
          fileContents = input.contents;
          writes.push(input.contents);
          trace.push("write");
          return { relativePath: input.relativePath };
        }),
      createFileExclusive: () => Effect.die("unused"),
      deleteFile: () => Effect.die("unused"),
    },
    versionStore: args.versionStore,
  } as unknown as Parameters<typeof resolveBoardProposal>[0];

  return { recorded, writes, trace, deps };
};

const decodeWorkflowDefinitionSync = (input: unknown) =>
  Schema.decodeUnknownSync(WorkflowDefinition)(input);

versionRoundTripLayer("resolveBoardProposal (self-improve E6)", (it) => {
  it.effect(
    "approve a clean pending proposal → save with base hash + self-improve source → approved",
    () =>
      Effect.gen(function* () {
        const versionStore = yield* WorkflowBoardVersionStore;
        const h = makeResolveHarness({ versionStore });

        const result = yield* resolveBoardProposal(h.deps, {
          proposalId: "prop-e6-1",
          action: "approve",
        });

        assert.equal(result.ok, true);
        if (result.ok !== true) {
          assert.fail("expected approve to succeed");
        }
        assert.equal(result.proposal.status, "approved");
        assert.isNotNull(result.proposal.appliedVersionHash);
        assert.isNotNull(result.proposal.resolvedAt);
        // saveBoardDefinition was called exactly once (one write).
        assert.equal(h.writes.length, 1);
        // status transition stamped approved + applied hash.
        const approved = h.recorded.find((r) => r.status === "approved");
        assert.isDefined(approved);
        assert.equal(approved?.fromStatus, "pending");
        assert.isDefined(approved?.appliedVersionHash);
        assert.equal(approved?.appliedVersionHash, result.proposal.appliedVersionHash);
      }),
  );

  it.effect("approve blocked by a modified lane holding live work → live_tickets, no save", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      // The proposal modifies the `backlog` lane; backlog is live-occupied.
      const h = makeResolveHarness({ versionStore, liveOccupiedLanes: ["backlog"] });

      const result = yield* resolveBoardProposal(h.deps, {
        proposalId: "prop-e6-1",
        action: "approve",
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) {
        assert.fail("expected live_tickets rejection");
      }
      assert.equal(result.reason, "live_tickets");
      assert.include(result.message, "backlog");
      // saveBoardDefinition NOT called; proposal stays pending (no status write).
      assert.equal(h.writes.length, 0);
      assert.equal(h.recorded.length, 0);
    }),
  );

  it.effect("approve NOT blocked when only an UNCHANGED lane holds live work", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      // Proposal modifies `backlog`; `work` (unchanged) is the occupied lane.
      const h = makeResolveHarness({ versionStore, liveOccupiedLanes: ["work"] });

      const result = yield* resolveBoardProposal(h.deps, {
        proposalId: "prop-e6-1",
        action: "approve",
      });

      assert.equal(result.ok, true);
      if (result.ok !== true) {
        assert.fail("expected approve to succeed (idle modified lane)");
      }
      assert.equal(result.proposal.status, "approved");
      assert.equal(h.writes.length, 1);
    }),
  );

  it.effect("approve blocked by a QUEUED ticket in a changed lane → live_tickets, no save", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      // listLiveOccupiedLanes surfaces queued tickets (3b fix), so a queued
      // ticket in the modified `backlog` lane makes it live-occupied → block.
      const h = makeResolveHarness({ versionStore, liveOccupiedLanes: ["backlog"] });

      const result = yield* resolveBoardProposal(h.deps, {
        proposalId: "prop-e6-1",
        action: "approve",
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) {
        assert.fail("expected live_tickets rejection for a queued ticket in a changed lane");
      }
      assert.equal(result.reason, "live_tickets");
      assert.include(result.message, "backlog");
      assert.equal(h.writes.length, 0);
      assert.equal(h.recorded.length, 0);
    }),
  );

  it.effect("approve NOT blocked by a QUEUED ticket in an UNCHANGED lane", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      // Queued ticket sits in `work` (unchanged) → does not block the apply.
      const h = makeResolveHarness({ versionStore, liveOccupiedLanes: ["work"] });

      const result = yield* resolveBoardProposal(h.deps, {
        proposalId: "prop-e6-1",
        action: "approve",
      });

      assert.equal(result.ok, true);
      if (result.ok !== true) {
        assert.fail("expected approve to succeed (queued in unchanged lane)");
      }
      assert.equal(result.proposal.status, "approved");
      assert.equal(h.writes.length, 1);
    }),
  );

  it.effect("approve an outdated proposal → conflict, status superseded, no save", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const h = makeResolveHarness({ versionStore, outdated: true });

      const result = yield* resolveBoardProposal(h.deps, {
        proposalId: "prop-e6-1",
        action: "approve",
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) {
        assert.fail("expected conflict");
      }
      assert.equal(result.reason, "conflict");
      assert.equal(h.writes.length, 0);
      const superseded = h.recorded.find((r) => r.status === "superseded");
      assert.isDefined(superseded);
      assert.equal(superseded?.fromStatus, "pending");
    }),
  );

  it.effect(
    "approve when saveBoardDefinition returns lintErrors → lint, status stays pending",
    () =>
      Effect.gen(function* () {
        const versionStore = yield* WorkflowBoardVersionStore;
        const h = makeResolveHarness({
          versionStore,
          lint: () =>
            Effect.succeed([
              { code: "missing_lane_ref", message: "lane target missing" } satisfies LintError,
            ]),
        });

        const result = yield* resolveBoardProposal(h.deps, {
          proposalId: "prop-e6-1",
          action: "approve",
        });

        assert.equal(result.ok, false);
        if (result.ok !== false) {
          assert.fail("expected lint rejection");
        }
        assert.equal(result.reason, "lint");
        assert.isDefined(result.lintErrors);
        assert.equal(result.lintErrors?.length, 1);
        // Lint is detected before the write; proposal stays pending (no status write).
        assert.equal(h.recorded.length, 0);
      }),
  );

  it.effect("approve when the on-disk board drifted from base → conflict, superseded", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      // The proposal is NOT flagged outdated (view.outdated false) but the actual
      // file hash no longer matches base → saveBoardDefinition returns conflict.
      const h = makeResolveHarness({ versionStore, currentFileMatchesBase: false });

      const result = yield* resolveBoardProposal(h.deps, {
        proposalId: "prop-e6-1",
        action: "approve",
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) {
        assert.fail("expected conflict from save");
      }
      assert.equal(result.reason, "conflict");
      assert.equal(h.writes.length, 0);
      const superseded = h.recorded.find((r) => r.status === "superseded");
      assert.isDefined(superseded);
    }),
  );

  it.effect("reject → status rejected, no save", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const h = makeResolveHarness({ versionStore });

      const result = yield* resolveBoardProposal(h.deps, {
        proposalId: "prop-e6-1",
        action: "reject",
      });

      assert.equal(result.ok, true);
      if (result.ok !== true) {
        assert.fail("expected reject ok");
      }
      assert.equal(result.proposal.status, "rejected");
      assert.equal(h.writes.length, 0);
      const rejected = h.recorded.find((r) => r.status === "rejected");
      assert.isDefined(rejected);
      assert.equal(rejected?.fromStatus, "pending");
    }),
  );

  it.effect(
    "approving an already-resolved (non-pending) proposal → ok:false invalid, no save",
    () =>
      Effect.gen(function* () {
        const versionStore = yield* WorkflowBoardVersionStore;
        const h = makeResolveHarness({ versionStore, proposalStatus: "approved" });

        const result = yield* resolveBoardProposal(h.deps, {
          proposalId: "prop-e6-1",
          action: "approve",
        });

        // Finding #4: a non-pending proposal is NOT actionable; never report ok:true.
        assert.equal(result.ok, false);
        if (result.ok !== false) {
          assert.fail("expected ok:false for a non-pending approve");
        }
        assert.equal(result.reason, "invalid");
        assert.equal(h.writes.length, 0);
        assert.equal(h.recorded.length, 0);
      }),
  );

  // CRITICAL invariant: resolve-approve is the SOLE saveBoardDefinition caller for
  // proposals. propose/list/get must NEVER write a board definition. We wire a
  // board-file writer that fails loudly and confirm none of those paths touch it.
  it.effect(
    "propose / list / get NEVER call saveBoardDefinition (only resolve-approve writes)",
    () =>
      Effect.gen(function* () {
        let wrote = false;
        const recorded: Array<unknown> = [];
        const proposed = {
          ...proposalBaseDefinition,
          lanes: proposalBaseDefinition.lanes.map((lane) =>
            (lane.key as string) === "work" ? { ...lane, name: "Work (revised)" } : lane,
          ),
        };
        // Augment the propose deps with a writer that records any board-file write.
        const baseDeps = makeProposeDeps({
          recorded,
          gen: () =>
            Effect.succeed({ proposedDefinition: proposed, rationale: "renamed the work lane" }),
        });
        const deps = {
          ...baseDeps,
          workspaceFileSystem: {
            readFile: () => Effect.die("unused"),
            listFiles: () => Effect.succeed([]),
            readFileString: () => Effect.succeed("{}"),
            writeFile: () =>
              Effect.sync(() => {
                wrote = true;
                return { relativePath: "x" };
              }),
            createFileExclusive: () => Effect.die("unused"),
            deleteFile: () => Effect.die("unused"),
          },
        } as unknown as Parameters<typeof proposeBoardImprovement>[0];

        yield* proposeBoardImprovement(deps, {
          boardId: proposalBoardId,
          agent: proposalAgent,
        });
        assert.isFalse(wrote, "proposeBoardImprovement must not write a board definition");

        const listDeps = {
          readModel: { ...noopReadModel, listBoardProposals: () => Effect.succeed([]) },
          observeRpcEffect: <A, E, R>(_m: string, e: Effect.Effect<A, E, R>) => e,
        };
        yield* listBoardProposals(listDeps, { boardId: proposalBoardId });

        const view = stubProposalView();
        const getDeps = {
          readModel: {
            ...noopReadModel,
            getBoardProposal: () =>
              Effect.succeed({
                view,
                proposedDefinition: encodeWorkflowDefinition(proposalBaseDefinition),
                baseDefinition: encodeWorkflowDefinition(proposalBaseDefinition),
              }),
          },
          observeRpcEffect: <A, E, R>(_m: string, e: Effect.Effect<A, E, R>) => e,
        };
        yield* getBoardProposal(getDeps, { proposalId: "prop-e5-1" });

        assert.isFalse(wrote, "no proposal read/propose path may write a board definition");
      }),
  );

  // ── Finding #1 — admission lock wraps the live-gate + save (TOCTOU) ─────────
  it.effect("approve runs the live-gate + save INSIDE the board admission lock", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const h = makeResolveHarness({ versionStore });

      const result = yield* resolveBoardProposal(h.deps, {
        proposalId: "prop-e6-1",
        action: "approve",
      });

      assert.equal(result.ok, true);
      // The board write must be bracketed by the admission lock — proving no
      // ticket can enter a changed lane between the gate and the write.
      assert.deepEqual(h.trace, ["lock:enter", "write", "lock:exit"]);
    }),
  );

  it.effect("reject also takes the admission lock (cannot flip a proposal mid-apply)", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const h = makeResolveHarness({ versionStore });

      const result = yield* resolveBoardProposal(h.deps, {
        proposalId: "prop-e6-1",
        action: "reject",
      });

      assert.equal(result.ok, true);
      // Reject takes the lock (and writes nothing).
      assert.deepEqual(h.trace, ["lock:enter", "lock:exit"]);
      assert.equal(h.writes.length, 0);
    }),
  );

  // ── Finding #2 — apply-state durability: reconcile to approved on lost race ──
  it.effect("approve reconciles to 'approved' even if the guarded flip is raced (affected 0)", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      // The pending→approved guarded flip "loses" (a concurrent reject/supersede
      // slipped the row out of pending after the save); the forced reconcile wins.
      const h = makeResolveHarness({ versionStore, guardedStatusAffected: 0 });

      const result = yield* resolveBoardProposal(h.deps, {
        proposalId: "prop-e6-1",
        action: "approve",
      });

      assert.equal(result.ok, true);
      if (result.ok !== true) {
        assert.fail("expected approve ok after reconcile");
      }
      assert.equal(result.proposal.status, "approved");
      // The board WAS written, so the invariant (hash==proposed ⇒ approved) holds.
      assert.equal(h.writes.length, 1);
      // Two status writes: the guarded (affected 0) + the forced reconcile.
      const approvedWrites = h.recorded.filter((r) => r.status === "approved");
      assert.equal(approvedWrites.length, 2);
      const guarded = approvedWrites.find((r) => r.fromStatus === "pending");
      const forced = approvedWrites.find((r) => r.fromStatus === undefined);
      assert.isDefined(guarded, "guarded pending→approved flip attempted");
      assert.isDefined(forced, "forced reconcile (no fromStatus) applied");
      assert.isDefined(forced?.appliedVersionHash);
    }),
  );

  // ── Finding #3 — approve re-runs preservation + dry-run with current code ───
  it.effect("approve re-runs PRESERVATION and rejects a now-invalid proposal (no save)", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      // Proposed def changes the lane set in a way preservation forbids: drop the
      // `work` lane entirely (lane-key removal is a preservation violation).
      const proposedDropsLane = {
        ...resolveBaseDefinition,
        lanes: resolveBaseDefinition.lanes.filter((lane) => (lane.key as string) !== "work"),
      } satisfies WorkflowDefinitionType;
      const h = makeResolveHarness({ versionStore, proposedDefinition: proposedDropsLane });

      const result = yield* resolveBoardProposal(h.deps, {
        proposalId: "prop-e6-1",
        action: "approve",
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) {
        assert.fail("expected ok:false from re-validation");
      }
      assert.equal(result.reason, "invalid");
      assert.include(result.message, "preservation");
      // No save; proposal marked invalid.
      assert.equal(h.writes.length, 0);
      const invalidated = h.recorded.find((r) => r.status === "invalid");
      assert.isDefined(invalidated);
      assert.equal(invalidated?.fromStatus, "pending");
    }),
  );

  it.effect(
    "approve re-runs DRY-RUN and rejects a proposal that now regresses routing (no save)",
    () =>
      Effect.gen(function* () {
        const versionStore = yield* WorkflowBoardVersionStore;
        // Proposed def drops the `work` lane's step.on routing → its auto lane ends
        // in a NEW dead end (no_route) the base did not have → dry-run regression.
        const proposedDeadEnd = {
          ...resolveBaseDefinition,
          lanes: resolveBaseDefinition.lanes.map((lane) =>
            (lane.key as string) === "work"
              ? {
                  key: LaneKey.make("work"),
                  name: "Work",
                  entry: "auto",
                  pipeline: [
                    {
                      key: StepKey.make("code"),
                      type: "agent",
                      agent: { instance: "claude_main", model: "sonnet" },
                      instruction: "do the work",
                    },
                  ],
                }
              : lane,
          ),
        } satisfies WorkflowDefinitionType;
        const h = makeResolveHarness({ versionStore, proposedDefinition: proposedDeadEnd });

        const result = yield* resolveBoardProposal(h.deps, {
          proposalId: "prop-e6-1",
          action: "approve",
        });

        assert.equal(result.ok, false);
        if (result.ok !== false) {
          assert.fail("expected ok:false from dry-run re-validation");
        }
        assert.equal(result.reason, "invalid");
        assert.include(result.message, "regression");
        assert.equal(h.writes.length, 0);
        assert.isDefined(h.recorded.find((r) => r.status === "invalid"));
      }),
  );
});

// ─── revertBoardProposal (self-improve E7) ──────────────────────────────────

// For revert tests, "applied" state = board currently matches the proposedDef
// (i.e. the improvement was already applied). base_def_json holds the original.
// The revert restores base_def_json by calling saveBoardDefinition with
// expectedVersionHash = current board hash (= applied_version_hash).

interface RevertHarness {
  readonly recorded: Array<{
    readonly proposalId: string;
    readonly status: string;
    readonly resolvedAt: string;
    readonly appliedVersionHash?: string | null;
    readonly fromStatus?: string;
  }>;
  readonly writes: Array<string>;
  readonly trace: Array<string>;
  readonly deps: Parameters<typeof revertBoardProposal>[0];
}

const makeRevertHarness = (args: {
  readonly versionStore: WorkflowBoardVersionStore["Service"];
  readonly proposalStatus?:
    | "pending"
    | "approved"
    | "rejected"
    | "superseded"
    | "invalid"
    | "reverted";
  readonly proposedDefinition?: WorkflowDefinitionType;
  readonly baseDefinition?: WorkflowDefinitionType;
  // When true (default), the on-disk file matches proposedDef (the improvement is live).
  // The board's current hash must equal applied_version_hash for revert to proceed.
  readonly currentFileMatchesProposed?: boolean;
  readonly liveOccupiedLanes?: ReadonlyArray<string>;
  readonly lint?: () => Effect.Effect<ReadonlyArray<LintError>, never>;
  // Affected-row count for the guarded (approved→reverted) status flip. Default 1;
  // 0 exercises the reconciliation forced write.
  readonly guardedStatusAffected?: number;
}): RevertHarness => {
  const boardId = BoardId.make("project-revert__board");
  const projectId = "project-revert" as ProjectId;
  const workflowFilePath = ".t3/boards/revert.json";
  const workspaceRoot = "/tmp/project-revert-root";

  const baseDef = args.baseDefinition ?? resolveBaseDefinition;
  const proposedDef = args.proposedDefinition ?? resolveProposedDefinition;

  // The on-disk file holds the proposed (applied) definition by default.
  const proposedEncoded = decodeWorkflowDefinitionSync(proposedDef);
  const proposedFileContents = `${encodeWorkflowDefinitionJson(proposedEncoded)}\n`;
  const appliedVersionHash = sha256Hex(proposedFileContents);

  let fileContents =
    args.currentFileMatchesProposed === false
      ? `${encodeWorkflowDefinitionJson(decodeWorkflowDefinitionSync({ ...proposedDef, name: "Drifted" }))}\n`
      : proposedFileContents;

  let registryDefinition = proposedEncoded;
  let boardRow = {
    boardId,
    projectId,
    name: registryDefinition.name,
    workflowFilePath,
    workflowVersionHash: sha256Hex(fileContents),
    maxConcurrentTickets: 3,
  };

  const proposalView = stubProposalView({
    proposalId: "prop-e7-1",
    boardId,
    status: args.proposalStatus ?? "approved",
    // appliedVersionHash must match the current board hash for revert to proceed.
    ...(args.proposalStatus !== "pending" &&
    args.proposalStatus !== "rejected" &&
    args.proposalStatus !== "superseded" &&
    args.proposalStatus !== "invalid" &&
    args.proposalStatus !== "reverted"
      ? {}
      : {}),
  });
  // For a clean revert: appliedVersionHash == appliedVersionHash (the hash of proposed file)
  const view = {
    ...proposalView,
    appliedVersionHash,
  };

  const recorded: RevertHarness["recorded"] = [];
  const writes: Array<string> = [];
  const trace: Array<string> = [];

  const deps = {
    engine: {
      withBoardAdmissionLock: <A, E, R>(_boardId: BoardId, effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          trace.push("lock:enter");
          const result = yield* effect;
          trace.push("lock:exit");
          return result;
        }),
    },
    readModel: {
      ...noopReadModel,
      getBoard: (inputBoardId: BoardId) =>
        Effect.succeed(inputBoardId === boardId ? boardRow : null),
      getBoardProposal: (_proposalId: string) =>
        Effect.succeed({
          view,
          proposedDefinition: encodeWorkflowDefinition(decodeWorkflowDefinitionSync(proposedDef)),
          baseDefinition: encodeWorkflowDefinition(decodeWorkflowDefinitionSync(baseDef)),
        }),
      listLiveOccupiedLanes: (_boardId: BoardId) => Effect.succeed(args.liveOccupiedLanes ?? []),
      resolveBoardProposalStatus: (input: {
        proposalId: string;
        status: string;
        resolvedAt: string;
        appliedVersionHash?: string | null;
        fromStatus?: string;
      }) =>
        Effect.sync(() => {
          recorded.push(input);
          if (input.fromStatus !== undefined && args.guardedStatusAffected !== undefined) {
            return args.guardedStatusAffected;
          }
          return 1;
        }),
      listWorkSourceMappingsForBoard: () => Effect.succeed([]),
    },
    boardRegistry: {
      register: () => Effect.die("unused"),
      unregister: () => Effect.void,
      getDefinition: () => Effect.succeed(registryDefinition),
      listDefinitions: () => Effect.succeed([]),
      getLane: () => Effect.succeed(null),
    },
    projectWorkspaceResolver: {
      resolve: () => Effect.succeed(workspaceRoot),
    },
    fileLoader: {
      lintDefinition: args.lint ?? (() => Effect.succeed([])),
      loadAndRegister: (input: { readonly boardId: BoardId }) =>
        Effect.gen(function* () {
          const definition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
            Effect.mapError(
              (cause) => new WorkflowRpcError({ message: "round-trip decode failed", cause }),
            ),
          );
          registryDefinition = definition;
          boardRow = {
            ...boardRow,
            name: definition.name,
            workflowVersionHash: sha256Hex(fileContents),
          };
          return input.boardId;
        }),
    },
    workspaceFileSystem: {
      readFile: () => Effect.die("unused"),
      listFiles: () => Effect.succeed([]),
      readFileString: () => Effect.succeed(fileContents),
      writeFile: (input: { readonly relativePath: string; readonly contents: string }) =>
        Effect.sync(() => {
          fileContents = input.contents;
          writes.push(input.contents);
          trace.push("write");
          return { relativePath: input.relativePath };
        }),
      createFileExclusive: () => Effect.die("unused"),
      deleteFile: () => Effect.die("unused"),
    },
    versionStore: args.versionStore,
  } as unknown as Parameters<typeof revertBoardProposal>[0];

  return { recorded, writes, trace, deps };
};

versionRoundTripLayer("revertBoardProposal (self-improve E7)", (it) => {
  it.effect(
    "revert an approved proposal (board unchanged since apply, no live conflict) → restores base_def + source self-improve-revert → reverted",
    () =>
      Effect.gen(function* () {
        const versionStore = yield* WorkflowBoardVersionStore;
        const h = makeRevertHarness({ versionStore });

        const result = yield* revertBoardProposal(h.deps, { proposalId: "prop-e7-1" });

        assert.equal(result.ok, true);
        if (result.ok !== true) {
          assert.fail("expected revert to succeed");
        }
        assert.equal(result.proposal.status, "reverted");
        assert.isNotNull(result.proposal.resolvedAt);
        // saveBoardDefinition called exactly once.
        assert.equal(h.writes.length, 1);
        // The written content must decode to the BASE definition (not the proposed).
        const writtenDef = yield* decodeWorkflowDefinitionJson(h.writes[0]!).pipe(
          Effect.mapError((e) => new WorkflowRpcError({ message: String(e), cause: e })),
        );
        assert.equal(writtenDef.lanes[0]?.name, resolveBaseDefinition.lanes[0]?.name);
        // Status transition stamped reverted.
        const reverted = h.recorded.find((r) => r.status === "reverted");
        assert.isDefined(reverted);
        assert.equal(reverted?.fromStatus, "approved");
      }),
  );

  it.effect(
    "revert blocked by live-gate: a lane the improvement ADDED holds a ticket → live_tickets, no save",
    () =>
      Effect.gen(function* () {
        const versionStore = yield* WorkflowBoardVersionStore;
        // proposedDef renames backlog→"Inbox"; reverting = going from proposed→base.
        // "backlog" lane is CHANGED between proposed and base (name differs).
        // If backlog is live-occupied, revert must be blocked.
        const h = makeRevertHarness({ versionStore, liveOccupiedLanes: ["backlog"] });

        const result = yield* revertBoardProposal(h.deps, { proposalId: "prop-e7-1" });

        assert.equal(result.ok, false);
        if (result.ok !== false) {
          assert.fail("expected live_tickets rejection");
        }
        assert.equal(result.reason, "live_tickets");
        assert.include(result.message, "backlog");
        // saveBoardDefinition NOT called.
        assert.equal(h.writes.length, 0);
        assert.equal(h.recorded.length, 0);
      }),
  );

  it.effect(
    "revert when board changed since apply (current hash ≠ applied_version_hash) → conflict, no save",
    () =>
      Effect.gen(function* () {
        const versionStore = yield* WorkflowBoardVersionStore;
        // currentFileMatchesProposed: false → board drifted after apply → conflict.
        const h = makeRevertHarness({ versionStore, currentFileMatchesProposed: false });

        const result = yield* revertBoardProposal(h.deps, { proposalId: "prop-e7-1" });

        assert.equal(result.ok, false);
        if (result.ok !== false) {
          assert.fail("expected conflict");
        }
        assert.equal(result.reason, "conflict");
        // saveBoardDefinition NOT called; no status writes.
        assert.equal(h.writes.length, 0);
        assert.equal(h.recorded.length, 0);
      }),
  );

  it.effect("revert a pending proposal → clear invalid result, no save", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const h = makeRevertHarness({ versionStore, proposalStatus: "pending" });

      const result = yield* revertBoardProposal(h.deps, { proposalId: "prop-e7-1" });

      assert.equal(result.ok, false);
      if (result.ok !== false) {
        assert.fail("expected invalid result for non-approved proposal");
      }
      assert.equal(result.reason, "invalid");
      assert.equal(h.writes.length, 0);
      assert.equal(h.recorded.length, 0);
    }),
  );

  it.effect("revert a rejected proposal → clear invalid result, no save", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const h = makeRevertHarness({ versionStore, proposalStatus: "rejected" });

      const result = yield* revertBoardProposal(h.deps, { proposalId: "prop-e7-1" });

      assert.equal(result.ok, false);
      if (result.ok !== false) {
        assert.fail("expected invalid result for rejected proposal");
      }
      assert.equal(result.reason, "invalid");
      assert.equal(h.writes.length, 0);
      assert.equal(h.recorded.length, 0);
    }),
  );

  it.effect("revert is gated: no save on live_tickets path", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const h = makeRevertHarness({ versionStore, liveOccupiedLanes: ["backlog"] });

      const result = yield* revertBoardProposal(h.deps, { proposalId: "prop-e7-1" });

      // Confirm the false path has 0 writes (gate enforced).
      assert.equal(result.ok, false);
      assert.equal(h.writes.length, 0);
    }),
  );

  it.effect("revert is gated: no save on conflict path", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const h = makeRevertHarness({ versionStore, currentFileMatchesProposed: false });

      const result = yield* revertBoardProposal(h.deps, { proposalId: "prop-e7-1" });

      assert.equal(result.ok, false);
      assert.equal(h.writes.length, 0);
    }),
  );

  // ── Finding #1 — admission lock wraps the revert live-gate + save ──────────
  it.effect("revert runs the live-gate + save INSIDE the board admission lock", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const h = makeRevertHarness({ versionStore });

      const result = yield* revertBoardProposal(h.deps, { proposalId: "prop-e7-1" });

      assert.equal(result.ok, true);
      assert.deepEqual(h.trace, ["lock:enter", "write", "lock:exit"]);
    }),
  );

  // ── Finding #2 — revert reconciles to 'reverted' if the guarded flip is raced ─
  it.effect("revert reconciles to 'reverted' even if the guarded flip is raced (affected 0)", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const h = makeRevertHarness({ versionStore, guardedStatusAffected: 0 });

      const result = yield* revertBoardProposal(h.deps, { proposalId: "prop-e7-1" });

      assert.equal(result.ok, true);
      if (result.ok !== true) {
        assert.fail("expected revert ok after reconcile");
      }
      assert.equal(result.proposal.status, "reverted");
      assert.equal(h.writes.length, 1);
      const revertedWrites = h.recorded.filter((r) => r.status === "reverted");
      assert.equal(revertedWrites.length, 2);
      assert.isDefined(revertedWrites.find((r) => r.fromStatus === "approved"));
      assert.isDefined(revertedWrites.find((r) => r.fromStatus === undefined));
    }),
  );

  // ── Finding #4 — non-approved revert returns ok:false (covered above for
  //    pending/rejected; this asserts the superseded case explicitly). ────────
  it.effect("revert a superseded proposal → ok:false invalid, no save", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const h = makeRevertHarness({ versionStore, proposalStatus: "superseded" });

      const result = yield* revertBoardProposal(h.deps, { proposalId: "prop-e7-1" });

      assert.equal(result.ok, false);
      if (result.ok !== false) {
        assert.fail("expected ok:false for a non-approved revert");
      }
      assert.equal(result.reason, "invalid");
      assert.equal(h.writes.length, 0);
    }),
  );
});

// ─── generateWorkflowDraft (create-wizard agent-assisted, Task 6) ────────────

const draftProjectId = "project-draft" as ProjectId;
const draftAgent = { instance: "wizard_inst", model: "opus" } as const;

// A valid agent+approval+manual def. NOTE: the agent step deliberately OMITS
// `agent` and the second emits a DIFFERENT instance — the handler must inject
// the chosen agent into both BEFORE decode.
const draftGeneratedDef = {
  name: "Drafted board",
  sources: [],
  outbound: [],
  lanes: [
    { key: "backlog", name: "Backlog", entry: "manual" },
    {
      key: "build",
      name: "Build",
      entry: "auto",
      pipeline: [
        {
          key: "implement",
          type: "agent",
          instruction: "implement the work",
          on: { success: "review", failure: "backlog", blocked: "backlog" },
        },
      ],
    },
    {
      key: "review",
      name: "Review",
      entry: "auto",
      pipeline: [
        {
          key: "approve",
          type: "agent",
          agent: { instance: "SOMETHING_ELSE", model: "haiku" },
          instruction: "review the work",
          retry: { maxAttempts: 3, escalate: { instance: "esc", model: "opus" } },
          on: { success: "done", failure: "backlog", blocked: "backlog" },
        },
      ],
    },
    { key: "done", name: "Done", entry: "auto", terminal: true },
  ],
};

const makeDraftDeps = (args: {
  readonly gen: () => Effect.Effect<
    { readonly proposedDefinition: unknown; readonly rationale: string },
    TextGenerationError
  >;
  readonly lint?: () => Effect.Effect<ReadonlyArray<LintError>, WorkflowRpcError>;
  readonly writes: Array<unknown>;
}) => ({
  fileLoader: {
    lintDefinition: args.lint ?? (() => Effect.succeed([])),
    loadAndRegister: (input: unknown) =>
      Effect.sync(() => {
        args.writes.push(input);
        return BoardId.make("board-should-not-be-written");
      }),
  },
  projectWorkspaceResolver: { resolve: () => Effect.succeed("/tmp/project") },
  textGeneration: { generateBoardProposal: args.gen },
  // The dead-end dry-run gate needs a predicate evaluator. The always-false stub
  // means transitions never fire, so routing falls through to step.on / lane.on.
  predicates: stubPredicates,
});

it.effect(
  "generateWorkflowDraft → ok:true with the chosen agent injected into ALL agent steps; no persist",
  () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const deps = makeDraftDeps({
        writes,
        gen: () =>
          Effect.succeed({ proposedDefinition: draftGeneratedDef, rationale: "drafted it" }),
      });

      const result = yield* generateWorkflowDraft(deps, {
        projectId: draftProjectId,
        name: "Drafted board" as never,
        description: "I build then review" as never,
        agent: draftAgent,
      });

      assert.equal(result.ok, true);
      if (result.ok !== true) assert.fail("expected ok:true");
      assert.equal(result.rationale, "drafted it");
      // Every agent step carries the injected agent (overwriting / filling in).
      for (const lane of result.definition.lanes) {
        for (const step of lane.pipeline ?? []) {
          if (step.type === "agent") {
            assert.equal(step.agent.instance, "wizard_inst");
            assert.equal(step.agent.model, "opus");
          }
        }
      }
      // Nothing was persisted.
      assert.equal(writes.length, 0);
    }),
);

it.effect(
  "generateWorkflowDraft → ok:false when the generated board contains a forbidden step type; no persist",
  () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const forbiddenDef = {
        ...draftGeneratedDef,
        lanes: [
          ...draftGeneratedDef.lanes,
          {
            key: "ship",
            name: "Ship",
            entry: "auto",
            pipeline: [{ key: "merge-it", type: "merge", on: { success: "done" } }],
          },
        ],
      };
      const deps = makeDraftDeps({
        writes,
        gen: () => Effect.succeed({ proposedDefinition: forbiddenDef, rationale: "with a merge" }),
      });

      const result = yield* generateWorkflowDraft(deps, {
        projectId: draftProjectId,
        name: "B" as never,
        description: "d" as never,
        agent: draftAgent,
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) assert.fail("expected ok:false");
      assert.include(result.message, "forbidden");
      assert.equal(writes.length, 0);
    }),
);

it.effect(
  "generateWorkflowDraft → ok:false with lintErrors when the injected def fails strict lint; no persist",
  () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const deps = makeDraftDeps({
        writes,
        gen: () =>
          Effect.succeed({ proposedDefinition: draftGeneratedDef, rationale: "drafted it" }),
        lint: () =>
          Effect.succeed([
            { code: "missing_lane_ref", message: "transition to a missing lane" } as LintError,
          ]),
      });

      const result = yield* generateWorkflowDraft(deps, {
        projectId: draftProjectId,
        name: "B" as never,
        description: "d" as never,
        agent: draftAgent,
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) assert.fail("expected ok:false");
      assert.isDefined(result.lintErrors);
      assert.equal(result.lintErrors?.length, 1);
      assert.equal(writes.length, 0);
    }),
);

it.effect(
  "generateWorkflowDraft → ok:false SURFACES the specific decode reason (not an opaque message); no persist",
  () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      // A draft with an out-of-vocabulary `entry` — the most common LLM mistake.
      const badEntryDef = {
        name: "B",
        lanes: [{ key: "a", name: "A", entry: "automatic" }],
      };
      const deps = makeDraftDeps({
        writes,
        gen: () => Effect.succeed({ proposedDefinition: badEntryDef, rationale: "oops" }),
      });

      const result = yield* generateWorkflowDraft(deps, {
        projectId: draftProjectId,
        name: "B" as never,
        description: "d" as never,
        agent: draftAgent,
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) assert.fail("expected ok:false");
      // The message must name the actual violation + path, not a generic string.
      assert.include(result.message, "structurally invalid");
      assert.include(result.message, "entry");
      assert.include(result.message, "auto");
      assert.equal(writes.length, 0);
    }),
);

it.effect("generateWorkflowDraft → ok:false when generation fails", () =>
  Effect.gen(function* () {
    const writes: Array<unknown> = [];
    const deps = makeDraftDeps({
      writes,
      gen: () =>
        Effect.fail(
          new TextGenerationError({ operation: "generateBoardProposal", detail: "provider down" }),
        ),
    });

    const result = yield* generateWorkflowDraft(deps, {
      projectId: draftProjectId,
      name: "B" as never,
      description: "d" as never,
      agent: draftAgent,
    });

    assert.equal(result.ok, false);
    if (result.ok !== false) assert.fail("expected ok:false");
    assert.equal(writes.length, 0);
  }),
);

it.effect(
  "generateWorkflowDraft → ok:false when the generated board has too many lanes; no persist",
  () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      // MAX_DRY_RUN_LANES is 200 (private to the handler module). Build a
      // structurally-valid def with 201 manual lanes + 1 terminal lane so it
      // decodes cleanly, then trips the >200 lane-count guard BEFORE lint.
      const manyLanes = [
        ...Array.from({ length: 201 }, (_, i) => ({
          key: `lane-${i}`,
          name: `Lane ${i}`,
          entry: "manual" as const,
        })),
        { key: "done", name: "Done", entry: "auto" as const, terminal: true },
      ];
      const hugeDef = { name: "Huge board", sources: [], outbound: [], lanes: manyLanes };
      const deps = makeDraftDeps({
        writes,
        gen: () => Effect.succeed({ proposedDefinition: hugeDef, rationale: "too many lanes" }),
      });

      const result = yield* generateWorkflowDraft(deps, {
        projectId: draftProjectId,
        name: "B" as never,
        description: "d" as never,
        agent: draftAgent,
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) assert.fail("expected ok:false");
      assert.include(result.message, "too many lanes");
      assert.equal(writes.length, 0);
    }),
);

it.effect(
  "generateWorkflowDraft → forces the wizard's name even when the model emits a different one",
  () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      // The model emits name "Untitled"; the wizard input.name is "Release Flow".
      const deps = makeDraftDeps({
        writes,
        gen: () =>
          Effect.succeed({
            proposedDefinition: { ...draftGeneratedDef, name: "Untitled" },
            rationale: "drafted it",
          }),
      });

      const result = yield* generateWorkflowDraft(deps, {
        projectId: draftProjectId,
        name: "Release Flow" as never,
        description: "I build then review" as never,
        agent: draftAgent,
      });

      assert.equal(result.ok, true);
      if (result.ok !== true) assert.fail("expected ok:true");
      assert.equal(result.definition.name, "Release Flow");
      assert.equal(writes.length, 0);
    }),
);

it.effect(
  "generateWorkflowDraft → ok:false when the generated board strands tickets (dead-end auto lane); no persist",
  () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      // `build` is an auto lane whose only step has NO step.on routing and the
      // lane has no transitions / lane.on → the dry run ends in no_route (a
      // dead-end that strands tickets). There IS a terminal `done` lane, so lint
      // passes; only the dry-run gate catches this.
      const strandingDef = {
        name: "Stranding board",
        sources: [],
        outbound: [],
        lanes: [
          { key: "backlog", name: "Backlog", entry: "manual" },
          {
            key: "build",
            name: "Build",
            entry: "auto",
            pipeline: [{ key: "implement", type: "agent", instruction: "do work" }],
          },
          { key: "done", name: "Done", entry: "auto", terminal: true },
        ],
      };
      const deps = makeDraftDeps({
        writes,
        gen: () => Effect.succeed({ proposedDefinition: strandingDef, rationale: "no way out" }),
      });

      const result = yield* generateWorkflowDraft(deps, {
        projectId: draftProjectId,
        name: "B" as never,
        description: "d" as never,
        agent: draftAgent,
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) assert.fail("expected ok:false");
      assert.include(result.message, "strands tickets");
      assert.include(result.message, "build");
      assert.equal(writes.length, 0);
    }),
);

it.effect("generateWorkflowDraft → ok:false when a single lane is too large; no persist", () =>
  Effect.gen(function* () {
    const writes: Array<unknown> = [];
    // ONE auto lane with > MAX_IMPORT_PER_LANE (1000) pipeline steps. The
    // lane-COUNT guard would never catch this; the per-lane cap does.
    const hugeLaneDef = {
      name: "Huge lane board",
      sources: [],
      outbound: [],
      lanes: [
        { key: "backlog", name: "Backlog", entry: "manual" },
        {
          key: "build",
          name: "Build",
          entry: "auto",
          pipeline: Array.from({ length: 1001 }, (_unused, i) => ({
            key: `step-${i}`,
            type: "agent",
            instruction: "x",
            on: { success: "done", failure: "backlog", blocked: "backlog" },
          })),
        },
        { key: "done", name: "Done", entry: "auto", terminal: true },
      ],
    };
    const deps = makeDraftDeps({
      writes,
      gen: () => Effect.succeed({ proposedDefinition: hugeLaneDef, rationale: "huge lane" }),
    });

    const result = yield* generateWorkflowDraft(deps, {
      projectId: draftProjectId,
      name: "B" as never,
      description: "d" as never,
      agent: draftAgent,
    });

    assert.equal(result.ok, false);
    if (result.ok !== false) assert.fail("expected ok:false");
    assert.include(result.message, "lane that is too large");
    assert.equal(writes.length, 0);
  }),
);

it.effect(
  "generateWorkflowDraft → ok:false when the raw generated board exceeds the byte cap; no persist",
  () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      // A single lane whose step instruction is a multi-MB string → the raw
      // JSON.stringify length exceeds MAX_IMPORT_DEFINITION_CHARS (2_000_000)
      // BEFORE the forbidden-type walk / decode / lint.
      const giantInstruction = "x".repeat(2_500_000);
      const oversizedDef = {
        name: "Oversized board",
        sources: [],
        outbound: [],
        lanes: [
          { key: "backlog", name: "Backlog", entry: "manual" },
          {
            key: "build",
            name: "Build",
            entry: "auto",
            pipeline: [{ key: "implement", type: "agent", instruction: giantInstruction }],
          },
          { key: "done", name: "Done", entry: "auto", terminal: true },
        ],
      };
      const deps = makeDraftDeps({
        writes,
        gen: () => Effect.succeed({ proposedDefinition: oversizedDef, rationale: "too big" }),
      });

      const result = yield* generateWorkflowDraft(deps, {
        projectId: draftProjectId,
        name: "B" as never,
        description: "d" as never,
        agent: draftAgent,
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) assert.fail("expected ok:false");
      assert.include(result.message, "too large");
      assert.equal(writes.length, 0);
    }),
);

it.effect(
  "generateWorkflowDraft → ok:false (too large) for a MANY-STEPS raw board, before the inject walk; no persist",
  () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      // ONE lane with a huge NUMBER of small steps (not one giant string). The
      // raw JSON.stringify length exceeds MAX_IMPORT_DEFINITION_CHARS (2_000_000)
      // purely from the step count, so the byte cap MUST fire before the
      // injectAgentIntoSteps walk loops every step. ~60k small agent steps at
      // ~70 bytes each comfortably clears 2MB.
      const manyStepsDef = {
        name: "Many steps board",
        sources: [],
        outbound: [],
        lanes: [
          { key: "backlog", name: "Backlog", entry: "manual" },
          {
            key: "build",
            name: "Build",
            entry: "auto",
            pipeline: Array.from({ length: 60_000 }, (_unused, i) => ({
              key: `step-${i}`,
              type: "agent",
              instruction: "do work please",
            })),
          },
          { key: "done", name: "Done", entry: "auto", terminal: true },
        ],
      };
      const deps = makeDraftDeps({
        writes,
        gen: () => Effect.succeed({ proposedDefinition: manyStepsDef, rationale: "many steps" }),
      });

      const result = yield* generateWorkflowDraft(deps, {
        projectId: draftProjectId,
        name: "B" as never,
        description: "d" as never,
        agent: draftAgent,
      });

      assert.equal(result.ok, false);
      if (result.ok !== false) assert.fail("expected ok:false");
      assert.include(result.message, "too large");
      assert.equal(writes.length, 0);
    }),
);

// ── listImportableWorkItems (B3) ─────────────────────────────────────────────

it.effect("listImportableWorkItems annotates mapped items + reports sources", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("b1");
    const triageLane = LaneKey.make("triage");
    const doneLane = LaneKey.make("done");

    // A board definition with one github source.
    const definition = {
      name: "Test Board",
      lanes: [
        { key: triageLane, name: "Triage", entry: "manual" },
        { key: doneLane, name: "Done", entry: "auto", terminal: true },
      ],
      sources: [
        {
          id: "s1" as unknown as import("@t3tools/contracts").SourceId,
          provider: "github" as const,
          connectionRef: "c",
          selector: { owner: "acme", repo: "app" },
          destinationLane: triageLane,
          closedLane: doneLane,
          enabled: true,
        },
      ],
    } satisfies WorkflowDefinitionType;

    // Two external work items returned by the provider.
    const issue82 = {
      provider: "github" as const,
      externalId: "82",
      url: "https://github.com/acme/app/issues/82",
      lifecycle: "open" as const,
      version: {},
      fields: { title: "Fix bug 82", assignees: ["dev1"] },
    };
    const issue83 = {
      provider: "github" as const,
      externalId: "83",
      url: "https://github.com/acme/app/issues/83",
      lifecycle: "open" as const,
      version: {},
      fields: { title: "Add feature 83", assignees: [] },
    };

    // Stub provider.
    const stubProvider = {
      provider: "github" as const,
      selectorSchema: Schema.Struct({}),
      listPage: (_input: unknown) => Effect.succeed({ items: [issue82, issue83] }),
      getItem: () => Effect.die("unused"),
      viewer: () => Effect.succeed({ id: "octocat", aliases: ["octocat"] }),
      toImportableView: (input: { selector: unknown; item: { externalId: string } }) => ({
        displayRef: `#${input.item.externalId}`,
        container: "acme/app",
      }),
    };

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.die("unused"),
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
        ingestExternalEvent: () => Effect.die("unused"),
        resolveApproval: () => Effect.die("unused"),
        answerTicketStep: () => Effect.die("unused"),
        postTicketMessage: () => Effect.die("unused"),
        editTicketMessage: () => Effect.die("unused"),
        cancelStep: () => Effect.die("unused"),
        cancelBoardPipelines: () => Effect.die("unused"),
        cancelTicketPipelines: () => Effect.die("unused"),
        recoverBoardWip: () => Effect.die("unused"),
        completeRecoveredStep: () => Effect.die("unused"),
      },
      readModel: {
        ...noopReadModel,
        listWorkSourceMappingsForBoard: () =>
          Effect.succeed([
            {
              provider: "github",
              sourceId: "s1",
              externalId: "82",
              ticketId: "ticket-1",
              currentLaneKey: "triage",
            },
          ]),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: (id: BoardId) => Effect.succeed(id === boardId ? definition : null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: { getTicketDiff: () => Effect.die("unused") },
      ticketWorktrees: { resolveForTicket: () => Effect.die("unused") },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: { discover: () => Effect.succeed([]), list: () => Effect.succeed([]) },
      projectWorkspaceResolver: { resolve: () => Effect.succeed("/tmp/project") },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      workSourceProviders: {
        get: (_provider: import("@t3tools/contracts/workSource").WorkSourceProviderName) =>
          stubProvider as unknown as import("../Services/WorkSourceProvider.ts").WorkSourceProvider,
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const res = yield* invokeWorkflowHandler<
      import("@t3tools/contracts/workSource").ListImportableWorkItemsResult
    >(handlers, WORKFLOW_WS_METHODS.listImportableWorkItems, { boardId });

    const i82 = res.items.find((i) => i.externalId === "82");
    assert.equal(i82?.mappedTicketId, "ticket-1");
    assert.equal(i82?.mappedLane, "triage");
    assert.equal(res.items.find((i) => i.externalId === "83")?.mappedTicketId, null);
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0]?.sourceId, "s1");
  }),
);

it.effect("gates mutating RPCs behind readiness while reads bypass the gate", () =>
  Effect.gen(function* () {
    const projectId = "project-gate" as ProjectId;
    let moved = false;
    let gateCalls = 0;
    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () =>
          Effect.sync(() => {
            moved = true;
          }),
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        reopenTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        terminalAgentSessionThreadsForTicket: () => Effect.die("unused"),
        stopAgentSessionsForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
        withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        editTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: noopReadModel,
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: { getTicketDiff: () => Effect.die("unused") },
      ticketWorktrees: { resolveForTicket: () => Effect.die("unused") },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: { discover: () => Effect.succeed([]), list: () => Effect.succeed([]) },
      projectWorkspaceResolver: { resolve: () => Effect.succeed("/tmp/project") },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      // Simulate a runtime that is not ready / recovery failed: the gate fails
      // without ever running the wrapped effect.
      gate: () => {
        gateCalls += 1;
        return Effect.fail(new WorkflowRpcError({ message: "runtime not ready" }));
      },
    });

    // Mutating RPC is gated: it fails and never reaches the engine.
    const moveResult = yield* Effect.exit(
      invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.moveTicket, {
        ticketId: TicketId.make("ticket-1"),
        toLane: LaneKey.make("done"),
      }),
    );
    assert.strictEqual(moveResult._tag, "Failure");
    assert.equal(moved, false);
    assert.equal(gateCalls, 1);

    // Read RPC bypasses the gate entirely.
    const boards = yield* handlers[WORKFLOW_WS_METHODS.listBoards]({ projectId });
    assert.deepEqual(boards, []);
    assert.equal(gateCalls, 1);
  }),
);

it.effect("gates importWorkItems behind readiness; listImportableWorkItems bypasses the gate", () =>
  Effect.gen(function* () {
    let gateCalls = 0;
    // A provider/committer that DIE if ever reached: proves the gate blocks the
    // import body before any scan/reconcile work runs.
    const dyingProvider = {
      provider: "github" as const,
      selectorSchema: Schema.Struct({}),
      listPage: () => Effect.die("import body must not run when gated"),
      getItem: () => Effect.die("unused"),
      viewer: () => Effect.die("unused"),
      toImportableView: () => Effect.die("unused"),
    };
    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.die("unused"),
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
        ingestExternalEvent: () => Effect.die("unused"),
        resolveApproval: () => Effect.die("unused"),
        answerTicketStep: () => Effect.die("unused"),
        postTicketMessage: () => Effect.die("unused"),
        editTicketMessage: () => Effect.die("unused"),
        cancelStep: () => Effect.die("unused"),
        cancelBoardPipelines: () => Effect.die("unused"),
        cancelTicketPipelines: () => Effect.die("unused"),
        recoverBoardWip: () => Effect.die("unused"),
        completeRecoveredStep: () => Effect.die("unused"),
      },
      readModel: noopReadModel,
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: { getTicketDiff: () => Effect.die("unused") },
      ticketWorktrees: { resolveForTicket: () => Effect.die("unused") },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: { discover: () => Effect.succeed([]), list: () => Effect.succeed([]) },
      projectWorkspaceResolver: { resolve: () => Effect.succeed("/tmp/project") },
      workspaceFileSystem: {
        readFile: () => Effect.die("unused"),
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      workSourceProviders: {
        get: (_provider: import("@t3tools/contracts/workSource").WorkSourceProviderName) =>
          dyingProvider as unknown as import("../Services/WorkSourceProvider.ts").WorkSourceProvider,
      },
      sourceCommitter: {
        reconcileChunk: () => Effect.die("import body must not run when gated"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      // Simulate a runtime that is not ready / recovery failed: the gate fails
      // without ever running the wrapped effect.
      gate: () => {
        gateCalls += 1;
        return Effect.fail(new WorkflowRpcError({ message: "runtime not ready" }));
      },
    });

    // importWorkItems is a MUTATING method → gated: it fails with the gate's
    // WorkflowRpcError and never reaches the (dying) scan/reconcile body.
    const importResult = yield* Effect.exit(
      invokeWorkflowHandler<import("@t3tools/contracts/workSource").ImportWorkItemsResult>(
        handlers,
        WORKFLOW_WS_METHODS.importWorkItems,
        { boardId: BoardId.make("b1"), sourceId: "s1", externalIds: ["82"] },
      ),
    );
    assert.strictEqual(importResult._tag, "Failure");
    if (importResult._tag === "Failure") {
      // The gate's "runtime not ready" WorkflowRpcError — NOT a die from the
      // provider/committer, which proves the gate blocked the body.
      assert.isTrue(importResult.cause.toString().includes("runtime not ready"));
      assert.isFalse(Cause.hasDies(importResult.cause));
    }
    assert.equal(gateCalls, 1);

    // listImportableWorkItems is a READ → bypasses the gate. It returns null
    // definition → a clean WorkflowRpcError("board not found"), NOT the gate's
    // "runtime not ready" failure, and gateCalls stays at 1 (gate never invoked).
    const listResult = yield* Effect.exit(
      invokeWorkflowHandler<import("@t3tools/contracts/workSource").ListImportableWorkItemsResult>(
        handlers,
        WORKFLOW_WS_METHODS.listImportableWorkItems,
        { boardId: BoardId.make("b1") },
      ),
    );
    assert.strictEqual(listResult._tag, "Failure");
    if (listResult._tag === "Failure") {
      // Reached the handler body (board not found), proving the gate did not block it.
      assert.isTrue(listResult.cause.toString().includes("board not found"));
      assert.isFalse(listResult.cause.toString().includes("runtime not ready"));
    }
    assert.equal(gateCalls, 1);
  }),
);

// ── importWorkItems (B4) ──────────────────────────────────────────────────────

/** Shared test setup for importWorkItems tests. */
const makeImportDeps = (opts: {
  /** Items the provider scan returns. */
  scanItems: ReadonlyArray<{
    provider: "github";
    externalId: string;
    url: string;
    lifecycle: "open" | "closed";
    version: Record<string, unknown>;
    fields: { title: string; assignees: string[] };
  }>;
  /** Mappings present BEFORE reconcileChunk. */
  beforeMappings: ReadonlyArray<{
    provider: string;
    sourceId: string;
    externalId: string;
    ticketId: string;
    currentLaneKey: string;
  }>;
  /** Mappings present AFTER reconcileChunk (simulates projection update). */
  afterMappings: ReadonlyArray<{
    provider: string;
    sourceId: string;
    externalId: string;
    ticketId: string;
    currentLaneKey: string;
  }>;
  reconcileChunkCalls?: Array<{
    boardId: string;
    deltas: ReadonlyArray<{ _tag: string; item: { externalId: string } }>;
  }>;
}) => {
  const boardId = BoardId.make("b1");
  const triageLane = LaneKey.make("triage");
  const doneLane = LaneKey.make("done");

  const definition = {
    name: "Test Board",
    lanes: [
      { key: triageLane, name: "Triage", entry: "manual" as const },
      { key: doneLane, name: "Done", entry: "auto" as const, terminal: true },
    ],
    sources: [
      {
        id: "s1" as unknown as import("@t3tools/contracts").SourceId,
        provider: "github" as const,
        connectionRef: "c",
        selector: { owner: "acme", repo: "app" },
        destinationLane: triageLane,
        closedLane: doneLane,
        enabled: true,
      },
    ],
  } satisfies WorkflowDefinitionType;

  const stubProvider = {
    provider: "github" as const,
    selectorSchema: Schema.Struct({}),
    listPage: (_input: unknown) => Effect.succeed({ items: opts.scanItems }),
    getItem: () => Effect.die("unused"),
    viewer: () => Effect.succeed({ id: "octocat", aliases: ["octocat"] }),
    toImportableView: (input: { selector: unknown; item: { externalId: string } }) => ({
      displayRef: `#${input.item.externalId}`,
      container: "acme/app",
    }),
  };

  // Track before/after calls to simulate projection state after reconcileChunk.
  let callCount = 0;

  const capturedReconcileCalls = opts.reconcileChunkCalls ?? [];

  const handlers = workflowRpcHandlers({
    engine: {
      createTicket: () => Effect.die("unused"),
      editTicket: () => Effect.die("unused"),
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
      ingestExternalEvent: () => Effect.die("unused"),
      resolveApproval: () => Effect.die("unused"),
      answerTicketStep: () => Effect.die("unused"),
      postTicketMessage: () => Effect.die("unused"),
      editTicketMessage: () => Effect.die("unused"),
      cancelStep: () => Effect.die("unused"),
      cancelBoardPipelines: () => Effect.die("unused"),
      cancelTicketPipelines: () => Effect.die("unused"),
      recoverBoardWip: () => Effect.die("unused"),
      completeRecoveredStep: () => Effect.die("unused"),
    },
    readModel: {
      ...noopReadModel,
      listWorkSourceMappingsForBoard: () => {
        callCount += 1;
        // First call = before-state; second call = after-state.
        return callCount === 1
          ? Effect.succeed(opts.beforeMappings)
          : Effect.succeed(opts.afterMappings);
      },
    },
    boardRegistry: {
      register: () => Effect.die("unused"),
      unregister: () => Effect.void,
      getDefinition: (id: BoardId) => Effect.succeed(id === boardId ? definition : null),
      listDefinitions: () => Effect.succeed([]),
      getLane: () => Effect.succeed(null),
    },
    ticketDiff: { getTicketDiff: () => Effect.die("unused") },
    ticketWorktrees: { resolveForTicket: () => Effect.die("unused") },
    boardEvents: {
      publish: () => Effect.void,
      stream: () => Stream.empty,
      subscribe: () => Effect.succeed(Stream.empty),
    },
    fileLoader: {
      lintDefinition: () => Effect.succeed([]),
      loadAndRegister: () => Effect.die("unused"),
    },
    projectScriptTrust: noopProjectScriptTrust,
    connectionStore: noopConnectionStore,
    versionStore: noopVersionStore,
    boardDiscovery: { discover: () => Effect.succeed([]), list: () => Effect.succeed([]) },
    projectWorkspaceResolver: { resolve: () => Effect.succeed("/tmp/project") },
    workspaceFileSystem: {
      readFile: () => Effect.die("unused"),
      listFiles: () => Effect.succeed([]),
      readFileString: () => Effect.die("unused"),
      writeFile: () => Effect.die("unused"),
      createFileExclusive: () => Effect.die("unused"),
      deleteFile: () => Effect.die("unused"),
    },
    workSourceProviders: {
      get: (_provider: import("@t3tools/contracts/workSource").WorkSourceProviderName) =>
        stubProvider as unknown as import("../Services/WorkSourceProvider.ts").WorkSourceProvider,
    },
    sourceCommitter: {
      reconcileChunk: (bid, _lanes, deltas) =>
        Effect.sync(() => {
          capturedReconcileCalls.push({
            boardId: String(bid),
            deltas: deltas as ReadonlyArray<{ _tag: string; item: { externalId: string } }>,
          });
        }),
    },
    observeRpcEffect: (_method, effect) => effect,
    observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
  });

  return { handlers, boardId, capturedReconcileCalls };
};

it.effect("importWorkItems imports in-scope unmapped ids, skips mapped + out-of-scope", () =>
  Effect.gen(function* () {
    const issue82 = {
      provider: "github" as const,
      externalId: "82",
      url: "https://github.com/acme/app/issues/82",
      lifecycle: "open" as const,
      version: {},
      fields: { title: "Fix bug 82", assignees: [] },
    };
    const issue83 = {
      provider: "github" as const,
      externalId: "83",
      url: "https://github.com/acme/app/issues/83",
      lifecycle: "open" as const,
      version: {},
      fields: { title: "Add feature 83", assignees: [] },
    };

    // Scan returns issues 82 and 83. Issue 83 is already mapped before-state.
    // After reconcileChunk, issue 82 is now mapped (after-state).
    const { handlers, boardId } = makeImportDeps({
      scanItems: [issue82, issue83],
      beforeMappings: [
        {
          provider: "github",
          sourceId: "s1",
          externalId: "83",
          ticketId: "ticket-83",
          currentLaneKey: "triage",
        },
      ],
      afterMappings: [
        {
          provider: "github",
          sourceId: "s1",
          externalId: "83",
          ticketId: "ticket-83",
          currentLaneKey: "triage",
        },
        {
          provider: "github",
          sourceId: "s1",
          externalId: "82",
          ticketId: "ticket-82",
          currentLaneKey: "triage",
        },
      ],
    });

    // Client requests: "82" (importable), "83" (already mapped), "99" (not in scan).
    const res = yield* invokeWorkflowHandler<
      import("@t3tools/contracts/workSource").ImportWorkItemsResult
    >(handlers, WORKFLOW_WS_METHODS.importWorkItems, {
      boardId,
      sourceId: "s1",
      externalIds: ["82", "83", "99"],
    });

    assert.deepEqual(
      res.imported.map((i) => i.externalId),
      ["82"],
    );
    assert.equal(res.imported[0]?.ticketId, "ticket-82");

    const reasons = Object.fromEntries(res.skipped.map((s) => [s.externalId, s.reason]));
    assert.equal(reasons["83"], "already on board");
    assert.match(reasons["99"] ?? "", /not in source/i);
  }),
);

it.effect(
  "importWorkItems calls reconcileChunk with the correct delta and NOT in a save lock",
  () =>
    Effect.gen(function* () {
      const issue82 = {
        provider: "github" as const,
        externalId: "82",
        url: "https://github.com/acme/app/issues/82",
        lifecycle: "open" as const,
        version: {},
        fields: { title: "Fix bug 82", assignees: [] },
      };

      const capturedCalls: Array<{
        boardId: string;
        deltas: ReadonlyArray<{ _tag: string; item: { externalId: string } }>;
      }> = [];

      const { handlers, boardId } = makeImportDeps({
        scanItems: [issue82],
        beforeMappings: [],
        afterMappings: [
          {
            provider: "github",
            sourceId: "s1",
            externalId: "82",
            ticketId: "ticket-82",
            currentLaneKey: "triage",
          },
        ],
        reconcileChunkCalls: capturedCalls,
      });

      yield* invokeWorkflowHandler<import("@t3tools/contracts/workSource").ImportWorkItemsResult>(
        handlers,
        WORKFLOW_WS_METHODS.importWorkItems,
        { boardId, sourceId: "s1", externalIds: ["82"] },
      );

      // reconcileChunk was called exactly once.
      assert.equal(capturedCalls.length, 1);
      // The chunk contained exactly the delta for issue 82.
      assert.equal(capturedCalls[0]?.deltas.length, 1);
      assert.equal(capturedCalls[0]?.deltas[0]?._tag, "new");
      assert.equal(capturedCalls[0]?.deltas[0]?.item.externalId, "82");
    }),
);
