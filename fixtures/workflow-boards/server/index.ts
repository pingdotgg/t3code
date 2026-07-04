import { definePlugin, type PluginRegistration } from "@t3tools/plugin-sdk";
import { MessageId, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  BoardId,
  BoardSnapshot,
  LaneKey,
  StepRunId,
  TicketAttachment,
  TicketId,
  WORKFLOW_WS_METHODS,
  WorkflowCreateBoardInput,
  WorkflowRenameBoardInput,
  WorkflowRpcError,
  WorkflowSaveBoardDefinitionInput,
  type BoardTicketView,
  type StepRunStatus,
  type TicketStatus,
  type WorkflowNeedsAttentionTicketView,
  type WorkflowSaveBoardDefinitionResult,
  type WorkflowStepRunView,
  type WorkflowTicketDetailView,
} from "../contracts/workflow.ts";
import { migration001 } from "./migrations/001_WorkflowSchema.ts";
import { deleteWorkflowBoardOwnedState } from "./workflow/boardDeletion.ts";
import {
  decodeWorkflowDefinition,
  decodeWorkflowDefinitionJson,
  encodeWorkflowDefinition,
  getBoardVersion,
  isWorkflowBoardFilePath,
  listBoardVersions,
  loadWritableWorkflowBoardFile,
  persistWorkflowBoardDefinition,
  recordBoardVersionBestEffort,
  recordBoardVersionRequired,
  workflowDefinitionContentJson,
  workflowDefinitionVersionHash,
} from "./workflow/boardDefinitionWrite.ts";
import { slugifyBoardName, uniqueBoardSlug } from "./workflow/boardSlug.ts";
import { defaultBoardDefinition } from "./workflow/defaultBoard.ts";
import { sha256Hex } from "./workflow/workflowVersionHash.ts";
import { BoardRegistry } from "./workflow/Services/BoardRegistry.ts";
import { WorkflowAgentSessionStore } from "./workflow/Services/WorkflowAgentSessionStore.ts";
import { WorkflowBoardEvents } from "./workflow/Services/WorkflowBoardEvents.ts";
import { WorkflowBoardSaveLocks } from "./workflow/Services/WorkflowBoardSaveLocks.ts";
import { WorkflowBoardVersionStore } from "./workflow/Services/WorkflowBoardVersionStore.ts";
import { WorkflowEventStore } from "./workflow/Services/WorkflowEventStore.ts";
import type { StepRunRow, TicketRow } from "./workflow/Services/WorkflowReadModel.ts";
import { WorkflowReadModel } from "./workflow/Services/WorkflowReadModel.ts";
import { WorkflowTerminalsCapability } from "./workflow/Services/ScriptCancelRegistry.ts";
import {
  WorkflowEnvironmentsReadCapability,
  WorkflowFilesystemCapability,
  WorkflowHttpClientCapability,
  WorkflowSecretsCapability,
  WorkflowSourceControlCapability,
  WorkflowVcsCapability,
} from "./workflow/Services/WorkflowCapabilities.ts";
import {
  WorkflowAgentsCapability,
  WorkflowProjectionsReadCapability,
} from "./workflow/Services/WorkflowAgentPort.ts";
import { WorkflowEngine } from "./workflow/Services/WorkflowEngine.ts";
import { ProjectWorkspaceResolver } from "./workflow/Services/ProjectWorkspaceResolver.ts";
import { ProjectScriptTrust } from "./workflow/Services/ProjectScriptTrust.ts";
import { WorkflowFileLoader } from "./workflow/Services/WorkflowFileLoader.ts";
import { WorkflowGitHubPoller } from "./workflow/Services/WorkflowGitHubPoller.ts";
import { WorkflowRecovery } from "./workflow/Services/WorkflowRecovery.ts";
import { WorkflowThreadJanitor } from "./workflow/Services/WorkflowThreadJanitor.ts";
import { WorkflowWebhook } from "./workflow/Services/WorkflowWebhook.ts";
import { WorkflowWorktreeJanitor } from "./workflow/Services/WorkflowWorktreeJanitor.ts";
import { WorkSourceConnectionStore } from "./workflow/Services/WorkSourceConnectionStore.ts";
import { makeWorkflowRuntimeLive } from "./workflow/WorkflowRuntimeLive.ts";
import { makeWorkflowWebhookHttpDescriptor } from "./workflow/webhookRoute.ts";
import { WorkSourceConnectionView, WorkSourceProviderName } from "../contracts/workSource.ts";

const toPluginError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

type WorkflowRuntimeContext =
  | WorkflowEngine
  | WorkflowReadModel
  | BoardRegistry
  | WorkflowBoardEvents
  | ProjectWorkspaceResolver
  | WorkflowFileLoader
  | WorkflowBoardSaveLocks
  | WorkflowBoardVersionStore
  | WorkflowEventStore
  | WorkflowWebhook
  | WorkflowWorktreeJanitor
  | WorkflowThreadJanitor
  | WorkflowAgentSessionStore
  | ProjectScriptTrust
  | WorkSourceConnectionStore
  | SqlClient.SqlClient;

const workflowRpcError = (message: string, cause?: unknown) =>
  new WorkflowRpcError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const toWorkflowRpcError = (message: string) => (cause: unknown) =>
  workflowRpcError(message, cause);

const encodeBoardSnapshot = Schema.encodeSync(BoardSnapshot);

const NEEDS_ATTENTION_KINDS = new Set(["waiting_for_approval", "waiting_for_input", "blocked"]);
const validAttentionKind = (raw: string | null | undefined): string | null =>
  raw != null && NEEDS_ATTENTION_KINDS.has(raw) ? raw : null;

const toBoardTicketView = (ticket: TicketRow): BoardTicketView => ({
  ticketId: ticket.ticketId as TicketId,
  boardId: ticket.boardId as BoardId,
  title: ticket.title,
  ...(ticket.description === null ? {} : { description: ticket.description }),
  currentLaneKey: ticket.currentLaneKey as LaneKey,
  status: ticket.status as TicketStatus,
  ...(ticket.queuedAt === null ? {} : { queuedAt: ticket.queuedAt }),
  ...(ticket.dependsOn === undefined || ticket.dependsOn.length === 0
    ? {}
    : { dependsOn: ticket.dependsOn as ReadonlyArray<TicketId> }),
  ...(ticket.unresolvedDependencyCount === undefined || ticket.unresolvedDependencyCount === 0
    ? {}
    : { unresolvedDependencyCount: ticket.unresolvedDependencyCount }),
  ...(typeof ticket.tokenBudget === "number" ? { tokenBudget: ticket.tokenBudget } : {}),
  ...(ticket.updatedAt === undefined ? {} : { updatedAt: ticket.updatedAt }),
  ...(typeof ticket.totalTokens === "number" && ticket.totalTokens > 0
    ? { totalTokens: ticket.totalTokens }
    : {}),
  ...(typeof ticket.totalDurationMs === "number" && ticket.totalDurationMs > 0
    ? { totalDurationMs: ticket.totalDurationMs }
    : {}),
  ...(ticket.pr === undefined ? {} : { pr: ticket.pr }),
  ...(validAttentionKind(ticket.attentionKind) === null
    ? {}
    : { attentionKind: validAttentionKind(ticket.attentionKind) as never }),
  ...(ticket.attentionReason == null ? {} : { attentionReason: ticket.attentionReason }),
  ...(ticket.currentLane === undefined
    ? {}
    : {
        currentLane: {
          key: ticket.currentLane.key as LaneKey,
          name: ticket.currentLane.name,
          actions: ticket.currentLane.actions.map((action) => ({
            label: action.label,
            to: action.to as LaneKey,
            ...(action.hint === undefined ? {} : { hint: action.hint }),
          })),
        },
      }),
});

const toStepUsageView = (step: StepRunRow) => {
  if (
    step.inputTokens === null &&
    step.cachedInputTokens === null &&
    step.outputTokens === null &&
    step.totalTokens === null
  ) {
    return undefined;
  }
  return {
    ...(step.inputTokens === null ? {} : { inputTokens: step.inputTokens }),
    ...(step.cachedInputTokens === null ? {} : { cachedInputTokens: step.cachedInputTokens }),
    ...(step.outputTokens === null ? {} : { outputTokens: step.outputTokens }),
    ...(step.totalTokens === null ? {} : { totalTokens: step.totalTokens }),
  };
};

const toStepRunView = (step: StepRunRow): WorkflowStepRunView => ({
  stepRunId: step.stepRunId as never,
  stepKey: step.stepKey as never,
  stepType: step.stepType as never,
  ...(step.attempt === null || step.attempt === 1 ? {} : { attempt: step.attempt }),
  status: step.status as StepRunStatus,
  waitingReason: step.waitingReason,
  blockedReason: step.blockedReason,
  providerResponseKind: step.providerResponseKind,
  scriptThreadId: step.scriptThreadId as never,
  terminalId: step.terminalId,
  scriptStatus: step.scriptStatus as never,
  exitCode: step.exitCode,
  signal: step.signal,
  ...(step.output === null ? {} : { output: step.output }),
  ...(step.startedAt === null ? {} : { startedAt: step.startedAt as never }),
  ...(step.finishedAt === null ? {} : { finishedAt: step.finishedAt as never }),
  ...(toStepUsageView(step) === undefined ? {} : { usage: toStepUsageView(step) }),
  ...(step.providerThreadId === null ? {} : { providerThreadId: step.providerThreadId as never }),
});

const boardSnapshot = (
  boardId: BoardId,
): Effect.Effect<BoardSnapshot, Error, WorkflowRuntimeContext> =>
  Effect.gen(function* () {
    const readModel = yield* WorkflowReadModel;
    const boardRegistry = yield* BoardRegistry;
    const board = yield* readModel
      .getBoard(boardId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board")));
    if (!board) {
      return yield* workflowRpcError(`Workflow board ${boardId} was not found`);
    }

    const definition = yield* boardRegistry.getDefinition(boardId);
    if (!definition) {
      return yield* workflowRpcError(`Workflow board definition ${boardId} was not found`);
    }

    const tickets = yield* readModel
      .listTickets(boardId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow tickets")));

    return {
      projectId: board.projectId as ProjectId,
      board: {
        boardId,
        name: board.name,
        lanes: definition.lanes.map((lane) => ({
          key: lane.key,
          name: lane.name,
          entry: lane.entry,
          pipelineStepCount: lane.pipeline?.length ?? 0,
          ...(lane.wipLimit === undefined ? {} : { wipLimit: lane.wipLimit }),
          ...(lane.terminal === undefined ? {} : { terminal: lane.terminal }),
          ...(lane.actions === undefined || lane.actions.length === 0
            ? {}
            : { actions: lane.actions }),
        })),
      },
      tickets: tickets.map(toBoardTicketView),
    } satisfies BoardSnapshot;
  });

const ticketDetail = (
  ticketId: TicketId,
): Effect.Effect<WorkflowTicketDetailView, Error, WorkflowRuntimeContext> =>
  Effect.gen(function* () {
    const readModel = yield* WorkflowReadModel;
    const detail = yield* readModel
      .getTicketDetail(ticketId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow ticket detail")));
    if (!detail) {
      return yield* workflowRpcError(`Workflow ticket ${ticketId} was not found`);
    }
    const routeDecisions = yield* readModel
      .listTicketRouteDecisions(ticketId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow ticket route history")));

    return {
      routeHistory: routeDecisions.map((decision) => ({
        occurredAt: decision.occurredAt as never,
        ...(decision.fromLane === null ? {} : { fromLane: decision.fromLane as never }),
        toLane: decision.toLane as never,
        source: decision.source,
        ...(decision.matchedTransitionIndex === null
          ? {}
          : { matchedTransitionIndex: decision.matchedTransitionIndex }),
        ...(decision.eventName === null ? {} : { eventName: decision.eventName }),
        ...(decision.pipelineResult === null ? {} : { pipelineResult: decision.pipelineResult }),
        ...(decision.laneRunCount === null ? {} : { laneRunCount: decision.laneRunCount }),
        ...(decision.steps === null
          ? {}
          : {
              steps: Object.fromEntries(
                Object.entries(decision.steps).map(([stepKey, step]) => [
                  stepKey,
                  {
                    status: step.status,
                    ...(step.exitCode === null ? {} : { exitCode: step.exitCode }),
                    ...(step.verdict === null ? {} : { verdict: step.verdict }),
                  },
                ]),
              ),
            }),
      })),
      ticket: toBoardTicketView(detail.ticket),
      steps: detail.steps.map(toStepRunView),
      messages: detail.messages.map((message) => ({
        messageId: message.messageId,
        ticketId: message.ticketId,
        ...(message.stepRunId === null ? {} : { stepRunId: message.stepRunId }),
        author: message.author,
        body: message.body,
        attachments: [...message.attachments],
        createdAt: message.createdAt,
        ...(message.editedAt == null ? {} : { editedAt: message.editedAt }),
      })),
      ...(detail.syncedSource !== undefined ? { syncedSource: detail.syncedSource } : {}),
    } satisfies WorkflowTicketDetailView;
  });

const slugFromBoardEntry = (entry: { readonly filePath: string }): string | null => {
  const fileName = entry.filePath.split("/").at(-1);
  return fileName?.endsWith(".json") ? fileName.slice(0, -".json".length) : null;
};

const NoPayload = Schema.Struct({});
const ListBoardsPayload = Schema.Struct({ projectId: ProjectId });
const GetBoardPayload = Schema.Struct({ boardId: BoardId });
const GetTicketDetailPayload = Schema.Struct({ ticketId: TicketId });
const GetBoardVersionPayload = Schema.Struct({ boardId: BoardId, versionId: Schema.Int });
const CreateTicketPayload = Schema.Struct({
  boardId: BoardId,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  initialLane: LaneKey,
  dependsOn: Schema.optional(Schema.Array(TicketId)),
  tokenBudget: Schema.optional(NonNegativeInt),
});
const EditTicketPayload = Schema.Struct({
  ticketId: TicketId,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  dependsOn: Schema.optional(Schema.Array(TicketId)),
  tokenBudget: Schema.optional(Schema.NullOr(NonNegativeInt)),
});
const MoveTicketPayload = Schema.Struct({ ticketId: TicketId, toLane: LaneKey });
const RunLanePayload = Schema.Struct({ ticketId: TicketId });
const ResolveApprovalPayload = Schema.Struct({ stepRunId: StepRunId, approved: Schema.Boolean });
const AnswerTicketStepPayload = Schema.Struct({
  stepRunId: StepRunId,
  text: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(TicketAttachment)),
});
const PostTicketMessagePayload = Schema.Struct({
  ticketId: TicketId,
  text: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(TicketAttachment)),
});
const EditTicketMessagePayload = Schema.Struct({
  ticketId: TicketId,
  messageId: MessageId,
  body: Schema.String,
});
const SetProjectScriptTrustPayload = Schema.Struct({
  projectId: ProjectId,
  trusted: Schema.Boolean,
});
const CancelStepPayload = Schema.Struct({ stepRunId: StepRunId });
const GetBoardDigestPayload = Schema.Struct({
  boardId: BoardId,
  windowHours: Schema.optional(Schema.Number),
});
const GetBoardMetricsPayload = Schema.Struct({
  boardId: BoardId,
  windowDays: Schema.optional(Schema.Number),
});
const GetWebhookConfigPayload = Schema.Struct({
  boardId: BoardId,
  rotate: Schema.optional(Schema.Boolean),
});
const CreateWorkSourceConnectionPayload = Schema.Struct({
  provider: WorkSourceProviderName,
  displayName: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  authMode: Schema.optional(Schema.Literals(["pat", "basic", "bearer"])),
  baseUrl: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});
const DeleteWorkSourceConnectionPayload = Schema.Struct({
  connectionRef: TrimmedNonEmptyString,
});

const decodePayload = <A>(
  schema: Schema.Decoder<unknown> & { readonly Type: A },
  payload: unknown,
  message: string,
): Effect.Effect<A, WorkflowRpcError> =>
  Exit.match(Schema.decodeUnknownExit(schema)(payload), {
    onFailure: (error) => Effect.fail(toWorkflowRpcError(message)(error)),
    onSuccess: Effect.succeed,
  });

const createBoard = (
  filesystem: WorkflowFilesystemCapability["Service"],
  payload: unknown,
): Effect.Effect<
  { readonly boardId: BoardId; readonly snapshot: BoardSnapshot },
  Error,
  WorkflowRuntimeContext
> =>
  decodePayload(
    WorkflowCreateBoardInput,
    payload,
    "workflow board create input decode failed",
  ).pipe(
    Effect.flatMap((decoded) =>
      Effect.gen(function* () {
        const projectWorkspaceResolver = yield* ProjectWorkspaceResolver;
        const readModel = yield* WorkflowReadModel;
        const fileLoader = yield* WorkflowFileLoader;
        const saveLocks = yield* WorkflowBoardSaveLocks;
        const workspaceRoot = yield* projectWorkspaceResolver
          .resolve(decoded.projectId)
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to resolve workflow project root")));
        const existingEntries = yield* readModel
          .listBoardsForProject(decoded.projectId)
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to list workflow boards")));
        const existingSlugs = new Set(
          existingEntries.flatMap((entry) => {
            const slug = slugFromBoardEntry(entry);
            return slug === null ? [] : [slug];
          }),
        );
        const definition = defaultBoardDefinition({ name: decoded.name, agent: decoded.agent });
        const slug = uniqueBoardSlug(slugifyBoardName(definition.name), existingSlugs);
        const boardId = BoardId.make(`${decoded.projectId}__${slug}`);
        const relativePath = `.t3/boards/${slug}.json`;
        const contentJson = workflowDefinitionContentJson(definition);

        return yield* saveLocks.withSaveLock(
          boardId,
          Effect.gen(function* () {
            yield* filesystem
              .createFileExclusive({
                root: workspaceRoot,
                relativePath,
                contents: contentJson,
              })
              .pipe(Effect.mapError(toWorkflowRpcError("Failed to create workflow board file")));
            yield* fileLoader
              .loadAndRegister({
                boardId,
                projectId: decoded.projectId,
                workspaceRoot,
                relativePath,
              })
              .pipe(
                Effect.mapError(toWorkflowRpcError("Failed to register created workflow board")),
                Effect.tapError(() =>
                  filesystem.remove({ root: workspaceRoot, relativePath }).pipe(Effect.ignore),
                ),
              );

            const createdBoard = yield* readModel
              .getBoard(boardId)
              .pipe(Effect.mapError(toWorkflowRpcError("Failed to load created workflow board")));
            if (!createdBoard) {
              return yield* workflowRpcError(
                `Workflow board ${boardId} was not found after create`,
              );
            }
            yield* recordBoardVersionBestEffort({
              boardId,
              versionHash: createdBoard.workflowVersionHash,
              contentJson,
              source: "create",
            });
            const snapshot = yield* boardSnapshot(boardId);
            return { boardId, snapshot };
          }),
        );
      }),
    ),
  );

const saveBoardDefinition = (
  filesystem: WorkflowFilesystemCapability["Service"],
  input: WorkflowSaveBoardDefinitionInput,
): Effect.Effect<WorkflowSaveBoardDefinitionResult, Error, WorkflowRuntimeContext> =>
  Effect.gen(function* () {
    const saveLocks = yield* WorkflowBoardSaveLocks;
    return yield* saveLocks.withSaveLock(
      input.boardId,
      Effect.gen(function* () {
        const definition = yield* decodeWorkflowDefinition(input.definition).pipe(
          Effect.mapError(toWorkflowRpcError("workflow definition decode failed")),
        );
        const boardFile = yield* loadWritableWorkflowBoardFile(filesystem, input.boardId);
        const currentVersionHash = sha256Hex(boardFile.currentRaw);
        if (currentVersionHash !== input.expectedVersionHash) {
          return {
            ok: false as const,
            conflict: true as const,
            currentVersionHash,
          };
        }

        const persisted = yield* persistWorkflowBoardDefinition(filesystem, {
          boardId: input.boardId,
          projectId: boardFile.projectId,
          workspaceRoot: boardFile.workspaceRoot,
          relativePath: boardFile.board.workflowFilePath,
          definition,
          source: input.source ?? "save",
          notFoundAfterWriteMessage: `Workflow board ${input.boardId} was not found after save`,
        });
        if (persisted._tag === "lintErrors") {
          return { ok: false as const, lintErrors: persisted.lintErrors };
        }

        const snapshot = yield* boardSnapshot(input.boardId);
        return {
          ok: true as const,
          definition: persisted.definition,
          versionHash: persisted.versionHash,
          snapshot,
        };
      }),
    );
  });

const renameBoard = (
  filesystem: WorkflowFilesystemCapability["Service"],
  input: WorkflowRenameBoardInput,
): Effect.Effect<void, Error, WorkflowRuntimeContext> =>
  Effect.gen(function* () {
    const saveLocks = yield* WorkflowBoardSaveLocks;
    return yield* saveLocks.withSaveLock(
      input.boardId,
      Effect.gen(function* () {
        const readModel = yield* WorkflowReadModel;
        const boardRegistry = yield* BoardRegistry;
        const fileLoader = yield* WorkflowFileLoader;
        const versionStore = yield* WorkflowBoardVersionStore;
        const boardFile = yield* loadWritableWorkflowBoardFile(filesystem, input.boardId);
        const currentDefinition = yield* decodeWorkflowDefinitionJson(boardFile.currentRaw).pipe(
          Effect.mapError(toWorkflowRpcError("workflow board file decode failed")),
        );
        if (currentDefinition.name === input.name) {
          const fileVersionHash = sha256Hex(boardFile.currentRaw);
          const registeredDefinition = yield* boardRegistry.getDefinition(input.boardId);
          const registeredDefinitionHash =
            registeredDefinition === null
              ? null
              : workflowDefinitionVersionHash(registeredDefinition);
          const currentDefinitionHash = workflowDefinitionVersionHash(currentDefinition);
          const versions = yield* versionStore
            .list(input.boardId)
            .pipe(Effect.mapError(toWorkflowRpcError("Failed to list workflow board versions")));
          const projectionIsCurrent = boardFile.board.workflowVersionHash === fileVersionHash;
          const registryIsCurrent = registeredDefinitionHash === currentDefinitionHash;
          const historyIsCurrent = versions[0]?.versionHash === fileVersionHash;
          if (projectionIsCurrent && registryIsCurrent && historyIsCurrent) {
            return;
          }

          if (!projectionIsCurrent || !registryIsCurrent) {
            yield* fileLoader
              .loadAndRegister({
                boardId: input.boardId,
                projectId: boardFile.projectId,
                workspaceRoot: boardFile.workspaceRoot,
                relativePath: boardFile.board.workflowFilePath,
              })
              .pipe(Effect.mapError(toWorkflowRpcError("Failed to register saved workflow board")));

            const updatedBoard = yield* readModel
              .getBoard(input.boardId)
              .pipe(Effect.mapError(toWorkflowRpcError("Failed to load saved workflow board")));
            if (!updatedBoard) {
              return yield* workflowRpcError(
                `Workflow board ${input.boardId} was not found after rename`,
              );
            }
          }

          if (!historyIsCurrent) {
            yield* recordBoardVersionRequired({
              boardId: input.boardId,
              versionHash: fileVersionHash,
              contentJson: boardFile.currentRaw,
              source: "rename",
            });
          }
          return;
        }

        const persisted = yield* persistWorkflowBoardDefinition(filesystem, {
          boardId: input.boardId,
          projectId: boardFile.projectId,
          workspaceRoot: boardFile.workspaceRoot,
          relativePath: boardFile.board.workflowFilePath,
          definition: { ...currentDefinition, name: input.name },
          source: "rename",
          notFoundAfterWriteMessage: `Workflow board ${input.boardId} was not found after rename`,
          versionRecording: "required",
        });
        if (persisted._tag === "lintErrors") {
          return yield* workflowRpcError(
            `Workflow lint failed: ${persisted.lintErrors.map((error) => error.code).join(", ")}`,
          );
        }
      }),
    );
  });

const deleteBoard = (
  filesystem: WorkflowFilesystemCapability["Service"],
  boardId: BoardId,
): Effect.Effect<void, Error, WorkflowRuntimeContext> =>
  Effect.gen(function* () {
    const saveLocks = yield* WorkflowBoardSaveLocks;
    const readModel = yield* WorkflowReadModel;
    const boardRegistry = yield* BoardRegistry;
    const engine = yield* WorkflowEngine;
    const eventStore = yield* WorkflowEventStore;
    const webhook = yield* WorkflowWebhook;
    const versionStore = yield* WorkflowBoardVersionStore;
    const projectWorkspaceResolver = yield* ProjectWorkspaceResolver;
    const worktreeJanitor = yield* WorkflowWorktreeJanitor;
    const threadJanitor = yield* WorkflowThreadJanitor;
    const agentSessions = yield* WorkflowAgentSessionStore;
    const sql = yield* SqlClient.SqlClient;

    return yield* saveLocks
      .withSaveLock(
        boardId,
        Effect.gen(function* () {
          const board = yield* readModel
            .getBoard(boardId)
            .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board")));

          if (board) {
            if (!isWorkflowBoardFilePath(board.workflowFilePath)) {
              return yield* workflowRpcError(
                `Workflow board ${boardId} is not a deletable workflow board file`,
              );
            }

            const workspaceRoot = yield* projectWorkspaceResolver
              .resolve(board.projectId as ProjectId)
              .pipe(Effect.mapError(toWorkflowRpcError("Failed to resolve workflow project root")));

            yield* filesystem
              .remove({
                root: workspaceRoot,
                relativePath: board.workflowFilePath,
              })
              .pipe(Effect.mapError(toWorkflowRpcError("Failed to delete workflow board file")));
          }

          yield* deleteWorkflowBoardOwnedState(
            {
              sql,
              boardRegistry,
              engine,
              eventStore,
              webhook,
              readModel,
              versionStore,
              worktreeJanitor,
              threadJanitor,
              agentSessions,
            },
            boardId,
          ).pipe(Effect.mapError(toWorkflowRpcError("Failed to delete workflow board state")));
        }),
      )
      .pipe(Effect.tap(() => saveLocks.evict?.(boardId) ?? Effect.void));
  });

export default definePlugin({
  register: (hostApi) =>
    Effect.gen(function* () {
      // Acquire required capabilities so activation fails loudly if the
      // manifest ever drops a declaration recovery/runtime code relies on.
      const database = yield* hostApi.database;
      const filesystem = yield* hostApi.filesystem;
      const http = yield* hostApi.http;
      const agents = yield* hostApi.agents;
      const projectionsRead = yield* hostApi.projectionsRead;
      const secrets = yield* hostApi.secrets;
      const vcs = yield* hostApi.vcs;
      const terminals = yield* hostApi.terminals;
      const httpClient = yield* hostApi.httpClient;
      const sourceControl = yield* hostApi.sourceControl;
      const environmentsRead = yield* hostApi.environmentsRead;
      const runtimeReady = yield* Deferred.make<Context.Context<WorkflowRuntimeContext>, Error>();
      const appLayer = makeWorkflowRuntimeLive({ webhookBasePath: http.basePath }).pipe(
        Layer.provideMerge(
          workflowCapabilityLayers({
            agents,
            databaseClient: database.client,
            environmentsRead,
            filesystem,
            httpClient,
            projectionsRead,
            secrets,
            sourceControl,
            terminals,
            vcs,
          }),
        ),
      );
      const runWithRuntime = <A>(effect: Effect.Effect<A, Error, WorkflowRuntimeContext>) =>
        Deferred.await(runtimeReady).pipe(
          Effect.flatMap((ctx) => effect.pipe(Effect.provide(ctx))),
          Effect.mapError(toPluginError),
        );
      const streamWithRuntime = <A>(stream: Stream.Stream<A, Error, WorkflowRuntimeContext>) =>
        Stream.unwrap(
          Deferred.await(runtimeReady).pipe(
            Effect.map((ctx) => stream.pipe(Stream.provideContext(ctx))),
            Effect.mapError(toPluginError),
          ),
        );
      const registration: PluginRegistration = {
        migrations: [migration001],
        rpc: [
          {
            method: WORKFLOW_WS_METHODS.listBoards,
            scope: "read",
            readiness: "always",
            handler: (payload) =>
              runWithRuntime(
                Effect.gen(function* () {
                  const { projectId } = yield* decodePayload(
                    ListBoardsPayload,
                    payload,
                    "workflow list boards input decode failed",
                  );
                  const readModel = yield* WorkflowReadModel;
                  // Divergence from the fork: the plugin slice does not port
                  // BoardDiscovery. listBoardsForProject is the plugin analogue
                  // and returns rows without the fork's `error` field.
                  return yield* readModel
                    .listBoardsForProject(projectId)
                    .pipe(Effect.mapError(toWorkflowRpcError("Failed to list workflow boards")));
                }),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.getBoard,
            scope: "read",
            readiness: "always",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  GetBoardPayload,
                  payload,
                  "workflow get board input decode failed",
                ).pipe(
                  Effect.flatMap(({ boardId }) => boardSnapshot(boardId)),
                  Effect.map(encodeBoardSnapshot),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.getBoardDefinition,
            scope: "read",
            readiness: "always",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  GetBoardPayload,
                  payload,
                  "workflow get board definition input decode failed",
                ).pipe(
                  Effect.flatMap(({ boardId }) =>
                    Effect.gen(function* () {
                      const boardRegistry = yield* BoardRegistry;
                      const readModel = yield* WorkflowReadModel;
                      const definition = yield* boardRegistry.getDefinition(boardId);
                      if (!definition) {
                        return yield* workflowRpcError(
                          `Workflow board definition ${boardId} was not found`,
                        );
                      }

                      const board = yield* readModel
                        .getBoard(boardId)
                        .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board")));
                      if (!board) {
                        return yield* workflowRpcError(`Workflow board ${boardId} was not found`);
                      }

                      return {
                        definition: encodeWorkflowDefinition(definition),
                        versionHash: board.workflowVersionHash,
                      };
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.getWebhookConfig,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  GetWebhookConfigPayload,
                  payload,
                  "workflow webhook config input decode failed",
                ).pipe(
                  Effect.flatMap(({ boardId, rotate }) =>
                    Effect.gen(function* () {
                      const readModel = yield* WorkflowReadModel;
                      const board = yield* readModel
                        .getBoard(boardId)
                        .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board")));
                      if (!board) {
                        return yield* workflowRpcError(`Workflow board ${boardId} was not found`);
                      }

                      const webhook = yield* WorkflowWebhook;
                      const config = yield* webhook
                        .getConfig(boardId, rotate === true)
                        .pipe(Effect.mapError(toWorkflowRpcError("Failed to load webhook config")));
                      return {
                        path: config.path,
                        hasToken: config.hasToken,
                        ...(config.tokenPrefix === undefined
                          ? {}
                          : { tokenPrefix: config.tokenPrefix }),
                        ...(config.token === undefined ? {} : { token: config.token }),
                      };
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.listBoardVersions,
            scope: "read",
            readiness: "always",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  GetBoardPayload,
                  payload,
                  "workflow list board versions input decode failed",
                ).pipe(Effect.flatMap(({ boardId }) => listBoardVersions(filesystem, boardId))),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.getBoardVersion,
            scope: "read",
            readiness: "always",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  GetBoardVersionPayload,
                  payload,
                  "workflow get board version input decode failed",
                ).pipe(
                  Effect.flatMap(({ boardId, versionId }) => getBoardVersion(boardId, versionId)),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.getTicketDetail,
            scope: "read",
            readiness: "always",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  GetTicketDetailPayload,
                  payload,
                  "workflow ticket detail input decode failed",
                ).pipe(Effect.flatMap(({ ticketId }) => ticketDetail(ticketId))),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.createBoard,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                createBoard(filesystem, payload).pipe(
                  Effect.map(({ boardId, snapshot }) => ({
                    boardId,
                    snapshot: encodeBoardSnapshot(snapshot),
                  })),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.deleteBoard,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  GetBoardPayload,
                  payload,
                  "workflow delete board input decode failed",
                ).pipe(Effect.flatMap(({ boardId }) => deleteBoard(filesystem, boardId))),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.renameBoard,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  WorkflowRenameBoardInput,
                  payload,
                  "workflow board rename input decode failed",
                ).pipe(Effect.flatMap((input) => renameBoard(filesystem, input))),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.saveBoardDefinition,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  WorkflowSaveBoardDefinitionInput,
                  payload,
                  "workflow save board definition input decode failed",
                ).pipe(Effect.flatMap((input) => saveBoardDefinition(filesystem, input))),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.createTicket,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  CreateTicketPayload,
                  payload,
                  "workflow create ticket input decode failed",
                ).pipe(
                  Effect.flatMap((input) =>
                    Effect.gen(function* () {
                      const engine = yield* WorkflowEngine;
                      const ticketId = yield* engine
                        .createTicket({
                          boardId: input.boardId,
                          title: input.title,
                          initialLane: input.initialLane,
                          ...(input.description === undefined
                            ? {}
                            : { description: input.description }),
                          ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
                          ...(input.tokenBudget === undefined
                            ? {}
                            : { tokenBudget: input.tokenBudget }),
                        })
                        .pipe(
                          Effect.mapError(toWorkflowRpcError("Failed to create workflow ticket")),
                        );
                      return { ticketId };
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.editTicket,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  EditTicketPayload,
                  payload,
                  "workflow edit ticket input decode failed",
                ).pipe(
                  Effect.flatMap((input) =>
                    Effect.gen(function* () {
                      const engine = yield* WorkflowEngine;
                      yield* engine
                        .editTicket(input)
                        .pipe(
                          Effect.mapError(toWorkflowRpcError("Failed to edit workflow ticket")),
                        );
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.moveTicket,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  MoveTicketPayload,
                  payload,
                  "workflow move ticket input decode failed",
                ).pipe(
                  Effect.flatMap(({ ticketId, toLane }) =>
                    Effect.gen(function* () {
                      const engine = yield* WorkflowEngine;
                      yield* engine
                        .moveTicket(ticketId, toLane)
                        .pipe(
                          Effect.mapError(toWorkflowRpcError("Failed to move workflow ticket")),
                        );
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.runLane,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  RunLanePayload,
                  payload,
                  "workflow run lane input decode failed",
                ).pipe(
                  Effect.flatMap(({ ticketId }) =>
                    Effect.gen(function* () {
                      const engine = yield* WorkflowEngine;
                      yield* engine
                        .runLane(ticketId)
                        .pipe(Effect.mapError(toWorkflowRpcError("Failed to run workflow lane")));
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.resolveApproval,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  ResolveApprovalPayload,
                  payload,
                  "workflow resolve approval input decode failed",
                ).pipe(
                  Effect.flatMap(({ stepRunId, approved }) =>
                    Effect.gen(function* () {
                      const engine = yield* WorkflowEngine;
                      yield* engine
                        .resolveApproval(stepRunId, approved)
                        .pipe(
                          Effect.mapError(
                            toWorkflowRpcError("Failed to resolve workflow approval"),
                          ),
                        );
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.answerTicketStep,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  AnswerTicketStepPayload,
                  payload,
                  "workflow answer ticket step input decode failed",
                ).pipe(
                  Effect.flatMap((input) =>
                    Effect.gen(function* () {
                      const engine = yield* WorkflowEngine;
                      yield* engine
                        .answerTicketStep(input)
                        .pipe(
                          Effect.mapError(
                            toWorkflowRpcError("Failed to answer workflow ticket step"),
                          ),
                        );
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.postTicketMessage,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  PostTicketMessagePayload,
                  payload,
                  "workflow post ticket message input decode failed",
                ).pipe(
                  Effect.flatMap((input) =>
                    Effect.gen(function* () {
                      const engine = yield* WorkflowEngine;
                      yield* engine
                        .postTicketMessage(input)
                        .pipe(
                          Effect.mapError(
                            toWorkflowRpcError("Failed to post workflow ticket message"),
                          ),
                        );
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.editTicketMessage,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  EditTicketMessagePayload,
                  payload,
                  "workflow edit ticket message input decode failed",
                ).pipe(
                  Effect.flatMap((input) =>
                    Effect.gen(function* () {
                      const engine = yield* WorkflowEngine;
                      yield* engine
                        .editTicketMessage(input)
                        .pipe(
                          Effect.mapError(
                            toWorkflowRpcError("Failed to edit workflow ticket message"),
                          ),
                        );
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.setProjectScriptTrust,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  SetProjectScriptTrustPayload,
                  payload,
                  "workflow set project script trust input decode failed",
                ).pipe(
                  Effect.flatMap(({ projectId, trusted }) =>
                    Effect.gen(function* () {
                      const projectScriptTrust = yield* ProjectScriptTrust;
                      yield* projectScriptTrust
                        .setTrusted(projectId, trusted)
                        .pipe(
                          Effect.mapError(
                            toWorkflowRpcError("Failed to update project script trust"),
                          ),
                        );
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.cancelStep,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  CancelStepPayload,
                  payload,
                  "workflow cancel step input decode failed",
                ).pipe(
                  Effect.flatMap(({ stepRunId }) =>
                    Effect.gen(function* () {
                      const engine = yield* WorkflowEngine;
                      yield* engine
                        .cancelStep(stepRunId)
                        .pipe(
                          Effect.mapError(toWorkflowRpcError("Failed to cancel workflow step")),
                        );
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.getBoardDigest,
            scope: "read",
            readiness: "always",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  GetBoardDigestPayload,
                  payload,
                  "workflow board digest input decode failed",
                ).pipe(
                  Effect.flatMap((input) =>
                    Effect.gen(function* () {
                      const readModel = yield* WorkflowReadModel;
                      const windowHours =
                        input.windowHours === undefined || !Number.isFinite(input.windowHours)
                          ? 24
                          : Math.min(24 * 7, Math.max(1, Math.floor(input.windowHours)));
                      const digest = yield* readModel
                        .getBoardDigest(input.boardId, windowHours)
                        .pipe(
                          Effect.mapError(toWorkflowRpcError("Failed to compute board digest")),
                        );
                      return {
                        windowHours: digest.windowHours,
                        createdCount: digest.createdCount,
                        shippedCount: digest.shippedCount,
                        totalTokens: digest.totalTokens,
                        totalDurationMs: digest.totalDurationMs,
                        needsAttention: digest.needsAttention.map((row) => ({
                          ticketId: row.ticketId as TicketId,
                          title: row.title,
                          status: row.status,
                          laneKey: row.laneKey as LaneKey,
                          sinceMs: Math.max(0, Math.floor(row.sinceMs)),
                        })),
                      };
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.getBoardMetrics,
            scope: "read",
            readiness: "always",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  GetBoardMetricsPayload,
                  payload,
                  "workflow board metrics input decode failed",
                ).pipe(
                  Effect.flatMap((input) =>
                    Effect.gen(function* () {
                      const readModel = yield* WorkflowReadModel;
                      const validWindowDays = [1, 7, 30] as const;
                      const windowDays =
                        input.windowDays !== undefined &&
                        validWindowDays.includes(
                          input.windowDays as (typeof validWindowDays)[number],
                        )
                          ? input.windowDays
                          : 7;
                      return yield* readModel
                        .getBoardMetrics(input.boardId, windowDays)
                        .pipe(
                          Effect.mapError(toWorkflowRpcError("Failed to compute board metrics")),
                        );
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.listNeedsAttentionTickets,
            scope: "read",
            readiness: "always",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  NoPayload,
                  payload,
                  "workflow needs-attention tickets input decode failed",
                ).pipe(
                  Effect.flatMap(() =>
                    Effect.gen(function* () {
                      const readModel = yield* WorkflowReadModel;
                      const rows = yield* readModel
                        .listNeedsAttentionTickets()
                        .pipe(
                          Effect.mapError(
                            toWorkflowRpcError("Failed to list needs-attention tickets"),
                          ),
                        );
                      return rows.map(
                        (row): WorkflowNeedsAttentionTicketView => ({
                          ticketId: row.ticketId as never,
                          boardId: row.boardId as never,
                          boardName: row.boardName,
                          title: row.title,
                          status: row.status as never,
                          currentLaneKey: row.currentLaneKey as never,
                          attentionKind: validAttentionKind(row.attentionKind) as never,
                          attentionReason: row.attentionReason,
                          updatedAt: row.updatedAt,
                        }),
                      );
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.listWorkSourceConnections,
            scope: "read",
            readiness: "always",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  NoPayload,
                  payload,
                  "workflow list work-source connections input decode failed",
                ).pipe(
                  Effect.flatMap(() =>
                    Effect.gen(function* () {
                      const connectionStore = yield* WorkSourceConnectionStore;
                      return yield* connectionStore
                        .list()
                        .pipe(
                          Effect.mapError(
                            toWorkflowRpcError("Failed to list work-source connections"),
                          ),
                        );
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.createWorkSourceConnection,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  CreateWorkSourceConnectionPayload,
                  payload,
                  "workflow create work-source connection input decode failed",
                ).pipe(
                  Effect.flatMap((input) =>
                    Effect.gen(function* () {
                      const connectionStore = yield* WorkSourceConnectionStore;
                      const view = yield* connectionStore
                        .create(input)
                        .pipe(
                          Effect.mapError(
                            toWorkflowRpcError("Failed to create work-source connection"),
                          ),
                        );
                      return view satisfies WorkSourceConnectionView;
                    }),
                  ),
                ),
              ),
          },
          {
            method: WORKFLOW_WS_METHODS.deleteWorkSourceConnection,
            scope: "operate",
            readiness: "requires-ready",
            handler: (payload) =>
              runWithRuntime(
                decodePayload(
                  DeleteWorkSourceConnectionPayload,
                  payload,
                  "workflow delete work-source connection input decode failed",
                ).pipe(
                  Effect.flatMap(({ connectionRef }) =>
                    Effect.gen(function* () {
                      const connectionStore = yield* WorkSourceConnectionStore;
                      yield* connectionStore
                        .remove(connectionRef)
                        .pipe(
                          Effect.mapError(
                            toWorkflowRpcError("Failed to delete work-source connection"),
                          ),
                        );
                    }),
                  ),
                ),
              ),
          },
        ],
        http: [makeWorkflowWebhookHttpDescriptor((effect) => runWithRuntime(effect))],
        streams: [
          {
            method: WORKFLOW_WS_METHODS.subscribeBoard,
            scope: "read",
            readiness: "always",
            handler: (payload) =>
              streamWithRuntime(
                Stream.unwrap(
                  decodePayload(
                    GetBoardPayload,
                    payload,
                    "workflow subscribe board input decode failed",
                  ).pipe(
                    Effect.flatMap(({ boardId }) =>
                      Effect.gen(function* () {
                        const boardEvents = yield* WorkflowBoardEvents;
                        const live = yield* boardEvents.subscribe(boardId);
                        const snapshot = yield* boardSnapshot(boardId);
                        return Stream.concat(
                          Stream.make({ kind: "snapshot" as const, snapshot }),
                          live.pipe(Stream.map((ticket) => ({ kind: "ticket" as const, ticket }))),
                        );
                      }),
                    ),
                  ),
                ),
              ),
          },
        ],
        services: [
          {
            name: "workflow-runtime",
            run: () => runWorkflowRuntimeService(appLayer, runtimeReady),
          },
        ],
      };
      return registration;
    }).pipe(Effect.mapError(toPluginError)),
});

export const runWorkflowRuntimeService = <ROut, E>(
  appLayer: Layer.Layer<ROut, E, never>,
  runtimeReady: Deferred.Deferred<Context.Context<ROut>, Error>,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const boot = Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(appLayer, scope).pipe(
        Effect.mapError(toPluginError),
      );
      const recovery = Context.get(
        context as Context.Context<ROut | WorkflowRecovery>,
        WorkflowRecovery,
      );
      yield* recovery
        .recover()
        .pipe(
          Effect.retry(
            Schedule.recurs(2).pipe(Schedule.addDelay(() => Effect.succeed(Duration.seconds(1)))),
          ),
          Effect.mapError(toPluginError),
        );
      const webhook = Context.getOption(
        context as Context.Context<ROut | WorkflowWebhook>,
        WorkflowWebhook,
      );
      if (webhook._tag === "Some") {
        yield* webhook.value
          .start()
          .pipe(Effect.provideService(Scope.Scope, scope), Effect.mapError(toPluginError));
      }
      const poller = Context.get(
        context as Context.Context<ROut | WorkflowGitHubPoller>,
        WorkflowGitHubPoller,
      );
      yield* poller
        .start()
        .pipe(Effect.provideService(Scope.Scope, scope), Effect.mapError(toPluginError));
      yield* Deferred.succeed(runtimeReady, context).pipe(Effect.ignore);
      return yield* Effect.never;
    });
    return yield* boot.pipe(
      // Complete `runtimeReady` on EVERY non-success exit — typed failure, defect,
      // OR interruption-during-boot — so a handler awaiting it (runWithRuntime /
      // streamWithRuntime) always gets a failure instead of hanging forever.
      // `tapError` would only fire for typed failures and leak a defect/interrupt.
      Effect.onError((cause) => Deferred.failCause(runtimeReady, cause).pipe(Effect.ignore)),
      Effect.ensuring(Scope.close(scope, Exit.void).pipe(Effect.ignore)),
    );
  });

type WorkflowCapabilityLayerInput = {
  readonly agents: WorkflowAgentsCapability["Service"];
  readonly databaseClient: SqlClient.SqlClient;
  readonly environmentsRead: WorkflowEnvironmentsReadCapability["Service"];
  readonly filesystem: WorkflowFilesystemCapability["Service"];
  readonly httpClient: WorkflowHttpClientCapability["Service"];
  readonly projectionsRead: WorkflowProjectionsReadCapability["Service"];
  readonly secrets: WorkflowSecretsCapability["Service"];
  readonly sourceControl: WorkflowSourceControlCapability["Service"];
  readonly terminals: WorkflowTerminalsCapability["Service"];
  readonly vcs: WorkflowVcsCapability["Service"];
};

export const workflowCapabilityLayers = (input: WorkflowCapabilityLayerInput) =>
  Layer.mergeAll(
    Layer.succeed(SqlClient.SqlClient, input.databaseClient),
    Layer.succeed(WorkflowAgentsCapability, input.agents),
    Layer.succeed(WorkflowProjectionsReadCapability, input.projectionsRead),
    Layer.succeed(WorkflowVcsCapability, input.vcs),
    Layer.succeed(WorkflowTerminalsCapability, input.terminals),
    Layer.succeed(WorkflowSourceControlCapability, input.sourceControl),
    Layer.succeed(WorkflowEnvironmentsReadCapability, input.environmentsRead),
    Layer.succeed(WorkflowFilesystemCapability, input.filesystem),
    Layer.succeed(WorkflowSecretsCapability, input.secrets),
    Layer.succeed(WorkflowHttpClientCapability, input.httpClient),
  );
