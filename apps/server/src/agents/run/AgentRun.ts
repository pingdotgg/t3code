/**
 * Pure state machine for native agent runs. The surrounding application owns
 * persistence and side effects; this module only validates transitions and
 * folds the events it creates.
 */
import {
  AgentProfileBudgets,
  AgentProfileRef,
  AgentWorkspaceMode,
  AgentRunId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  type AgentProfileBudgets as AgentProfileBudgetsType,
  type AgentProfileRef as AgentProfileRefType,
  type AgentWorkspaceMode as AgentWorkspaceModeType,
  type AgentRunId as AgentRunIdType,
  type AgentRunStatus as AgentRunStatusType,
  type AgentRunSummary,
  type ModelSelection as ModelSelectionType,
  type ProjectId as ProjectIdType,
  type ProviderInstanceId as ProviderInstanceIdType,
  RuntimeTaskUsage,
  ThreadId,
  TurnId,
  type RuntimeTaskUsage as RuntimeTaskUsageType,
  type ThreadId as ThreadIdType,
  type TurnId as TurnIdType,
} from "@t3tools/contracts";
import {
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const AgentRunWaitReason = Schema.Literals(["children", "input"]);
export type AgentRunWaitReason = typeof AgentRunWaitReason.Type;

const NullableRunId = Schema.NullOr(AgentRunId);

const RequestedEvent = Schema.Struct({
  type: Schema.Literal("agent-run.requested"),
  runId: AgentRunId,
  revision: Schema.Literal(0),
  occurredAt: IsoDateTime,
  /** Root request time used for the lineage wall-time deadline. */
  wallTimeOriginAt: Schema.optionalKey(IsoDateTime),
  profile: AgentProfileRef,
  budget: AgentProfileBudgets,
  parentRunId: NullableRunId,
  rootRunId: AgentRunId,
  depth: NonNegativeInt,
  detached: Schema.Boolean,
  parentThreadId: ThreadId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  instanceId: ProviderInstanceId,
  workspaceMode: AgentWorkspaceMode,
});
const ChildThreadAssignedEvent = Schema.Struct({
  type: Schema.Literal("agent-run.child-thread-assigned"),
  runId: AgentRunId,
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
  childThreadId: ThreadId,
});
const StartedEvent = Schema.Struct({
  type: Schema.Literal("agent-run.started"),
  runId: AgentRunId,
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
});
const TurnBoundEvent = Schema.Struct({
  type: Schema.Literal("agent-run.turn-bound"),
  runId: AgentRunId,
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
  turnId: TurnId,
});
const WaitingEvent = Schema.Struct({
  type: Schema.Literal("agent-run.waiting"),
  runId: AgentRunId,
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
  reason: AgentRunWaitReason,
});
const ResumedEvent = Schema.Struct({
  type: Schema.Literal("agent-run.resumed"),
  runId: AgentRunId,
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
});
const ResultSucceededEvent = Schema.Struct({
  type: Schema.Literal("agent-run.result-succeeded"),
  runId: AgentRunId,
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
  usage: Schema.optionalKey(RuntimeTaskUsage),
});
const ResultFailedEvent = Schema.Struct({
  type: Schema.Literal("agent-run.result-failed"),
  runId: AgentRunId,
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
  failure: TrimmedNonEmptyString,
  usage: Schema.optionalKey(RuntimeTaskUsage),
});
const FollowUpRevisedEvent = Schema.Struct({
  type: Schema.Literal("agent-run.follow-up-revised"),
  runId: AgentRunId,
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
  message: TrimmedNonEmptyString,
});
const CancelledEvent = Schema.Struct({
  type: Schema.Literal("agent-run.cancelled"),
  runId: AgentRunId,
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
  reason: Schema.optionalKey(TrimmedString),
});
const IntegrationStartedEvent = Schema.Struct({
  type: Schema.Literal("agent-run.integration-started"),
  runId: AgentRunId,
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
  targetThreadId: ThreadId,
});
const IntegrationSucceededEvent = Schema.Struct({
  type: Schema.Literal("agent-run.integration-succeeded"),
  runId: AgentRunId,
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
});
const IntegrationConflictedEvent = Schema.Struct({
  type: Schema.Literal("agent-run.integration-conflicted"),
  runId: AgentRunId,
  revision: NonNegativeInt,
  occurredAt: IsoDateTime,
  failure: TrimmedNonEmptyString,
});

export const AgentRunEvent = Schema.Union([
  RequestedEvent,
  ChildThreadAssignedEvent,
  StartedEvent,
  TurnBoundEvent,
  WaitingEvent,
  ResumedEvent,
  ResultSucceededEvent,
  ResultFailedEvent,
  FollowUpRevisedEvent,
  CancelledEvent,
  IntegrationStartedEvent,
  IntegrationSucceededEvent,
  IntegrationConflictedEvent,
]);
export type AgentRunEvent = typeof AgentRunEvent.Type;

const RequestCommand = Schema.Struct({
  type: Schema.Literal("agent-run.request"),
  runId: AgentRunId,
  profile: AgentProfileRef,
  budget: AgentProfileBudgets,
  parentRunId: NullableRunId,
  detached: Schema.Boolean,
  parentThreadId: ThreadId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  instanceId: ProviderInstanceId,
  workspaceMode: AgentWorkspaceMode,
  occurredAt: IsoDateTime,
});
const AssignChildThreadCommand = Schema.Struct({
  type: Schema.Literal("agent-run.assign-child-thread"),
  runId: AgentRunId,
  childThreadId: ThreadId,
  occurredAt: IsoDateTime,
});
const StartCommand = Schema.Struct({
  type: Schema.Literal("agent-run.start"),
  runId: AgentRunId,
  occurredAt: IsoDateTime,
});
const BindTurnCommand = Schema.Struct({
  type: Schema.Literal("agent-run.bind-turn"),
  runId: AgentRunId,
  turnId: TurnId,
  occurredAt: IsoDateTime,
});
const WaitCommand = Schema.Struct({
  type: Schema.Literal("agent-run.wait"),
  runId: AgentRunId,
  occurredAt: IsoDateTime,
});
const ResumeCommand = Schema.Struct({
  type: Schema.Literal("agent-run.resume"),
  runId: AgentRunId,
  occurredAt: IsoDateTime,
});
const SucceedCommand = Schema.Struct({
  type: Schema.Literal("agent-run.succeed"),
  runId: AgentRunId,
  usage: Schema.optionalKey(RuntimeTaskUsage),
  occurredAt: IsoDateTime,
});
const FailCommand = Schema.Struct({
  type: Schema.Literal("agent-run.fail"),
  runId: AgentRunId,
  failure: TrimmedNonEmptyString,
  usage: Schema.optionalKey(RuntimeTaskUsage),
  occurredAt: IsoDateTime,
});
const FollowUpCommand = Schema.Struct({
  type: Schema.Literal("agent-run.follow-up"),
  runId: AgentRunId,
  message: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
});
const CancelCommand = Schema.Struct({
  type: Schema.Literal("agent-run.cancel"),
  runId: AgentRunId,
  reason: Schema.optionalKey(TrimmedString),
  occurredAt: IsoDateTime,
});
const StartIntegrationCommand = Schema.Struct({
  type: Schema.Literal("agent-run.start-integration"),
  runId: AgentRunId,
  targetThreadId: Schema.optionalKey(ThreadId),
  occurredAt: IsoDateTime,
});
const SucceedIntegrationCommand = Schema.Struct({
  type: Schema.Literal("agent-run.succeed-integration"),
  runId: AgentRunId,
  occurredAt: IsoDateTime,
});
const ConflictIntegrationCommand = Schema.Struct({
  type: Schema.Literal("agent-run.conflict-integration"),
  runId: AgentRunId,
  failure: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
});

export const AgentRunCommand = Schema.Union([
  RequestCommand,
  AssignChildThreadCommand,
  StartCommand,
  BindTurnCommand,
  WaitCommand,
  ResumeCommand,
  SucceedCommand,
  FailCommand,
  FollowUpCommand,
  CancelCommand,
  StartIntegrationCommand,
  SucceedIntegrationCommand,
  ConflictIntegrationCommand,
]);
export type AgentRunCommand = typeof AgentRunCommand.Type;

export class AgentRunCommandInvariantError extends Schema.TaggedErrorClass<AgentRunCommandInvariantError>()(
  "AgentRunCommandInvariantError",
  {
    commandType: Schema.String,
    runId: Schema.optionalKey(AgentRunId),
    reason: Schema.optionalKey(Schema.Literal("budget-exhausted")),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Agent run command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export interface AgentRun {
  readonly id: AgentRunIdType;
  readonly profile: AgentProfileRefType;
  readonly budget: AgentProfileBudgetsType;
  readonly status: AgentRunStatusType;
  readonly revision: number;
  readonly childThreadId: ThreadIdType | null;
  readonly parentRunId: AgentRunIdType | null;
  readonly rootRunId: AgentRunIdType;
  readonly depth: number;
  readonly detached: boolean;
  readonly parentThreadId: ThreadIdType;
  readonly projectId: ProjectIdType;
  readonly modelSelection: ModelSelectionType;
  readonly instanceId: ProviderInstanceIdType;
  readonly workspaceMode: AgentWorkspaceModeType;
  readonly requestedAt: string;
  /** Root request time used for the lineage wall-time deadline. */
  readonly wallTimeOriginAt: string;
  readonly startedAt: string | null;
  /** Provider turn currently authorized to advance this Agent run. */
  readonly activeTurnId: TurnIdType | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
  readonly usage: RuntimeTaskUsageType | undefined;
  /** Monotonic total used for lineage accounting across follow-up revisions. */
  readonly consumedTokens: number;
  readonly consumedEstimatedCostUsd: number;
  readonly failure: string | undefined;
  readonly waitingForChildren: boolean;
  readonly integrationTargetThreadId: ThreadIdType | null;
}

export interface AgentRunState {
  readonly runs: ReadonlyMap<AgentRunIdType, AgentRun>;
}

export const emptyAgentRunState = (): AgentRunState => ({ runs: new Map() });

export const summaryOf = (run: AgentRun): AgentRunSummary => ({
  id: run.id,
  profile: run.profile,
  status: run.status,
  revision: run.revision,
  childThreadId: run.childThreadId,
  parentRunId: run.parentRunId,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  updatedAt: run.updatedAt,
  ...(run.usage !== undefined ? { usage: run.usage } : {}),
  ...(run.failure !== undefined ? { failure: run.failure } : {}),
});

const activeForConcurrency = (run: AgentRun) =>
  run.status === "queued" || run.status === "running" || run.status === "integrating";
const isTerminal = (run: AgentRun) =>
  run.status === "succeeded" ||
  run.status === "failed" ||
  run.status === "cancelled" ||
  run.status === "integrated";
const runsInLineage = (state: AgentRunState, rootRunId: AgentRunIdType) =>
  [...state.runs.values()].filter((candidate) => candidate.rootRunId === rootRunId);
const totalTokens = (runs: ReadonlyArray<AgentRun>) =>
  runs.reduce((total, run) => total + run.consumedTokens, 0);
const totalEstimatedCostUsd = (runs: ReadonlyArray<AgentRun>) =>
  runs.reduce((total, run) => total + run.consumedEstimatedCostUsd, 0);
const wallTimeExceeded = (run: AgentRun, occurredAt: string) => {
  const elapsedMs = Date.parse(occurredAt) - Date.parse(run.wallTimeOriginAt);
  return Number.isFinite(elapsedMs) && elapsedMs > run.budget.maxWallTimeMinutes * 60_000;
};

const nextEvent = <Event extends AgentRunEvent>(event: Event): Event => event;
const withRevision = (run: AgentRun, occurredAt: string) => ({
  runId: run.id,
  revision: run.revision + 1,
  occurredAt,
});

export const evolve = (state: AgentRunState, event: AgentRunEvent): AgentRunState => {
  const runs = new Map(state.runs);
  const current = runs.get(event.runId);
  switch (event.type) {
    case "agent-run.requested":
      runs.set(event.runId, {
        id: event.runId,
        profile: event.profile,
        budget: event.budget,
        status: "queued",
        revision: event.revision,
        childThreadId: null,
        parentRunId: event.parentRunId,
        rootRunId: event.rootRunId,
        depth: event.depth,
        detached: event.detached,
        parentThreadId: event.parentThreadId,
        projectId: event.projectId,
        modelSelection: event.modelSelection,
        instanceId: event.instanceId,
        workspaceMode: event.workspaceMode,
        requestedAt: event.occurredAt,
        // Older persisted events omit wallTimeOriginAt, so their own
        // creation time remains the safe replay fallback.
        wallTimeOriginAt: event.wallTimeOriginAt ?? event.occurredAt,
        startedAt: null,
        activeTurnId: null,
        finishedAt: null,
        updatedAt: event.occurredAt,
        usage: undefined,
        consumedTokens: 0,
        consumedEstimatedCostUsd: 0,
        failure: undefined,
        waitingForChildren: false,
        integrationTargetThreadId: null,
      });
      return { runs };
    default:
      if (!current) return state;
  }
  switch (event.type) {
    case "agent-run.child-thread-assigned":
      runs.set(event.runId, {
        ...current,
        childThreadId: event.childThreadId,
        revision: event.revision,
        updatedAt: event.occurredAt,
      });
      break;
    case "agent-run.started":
    case "agent-run.resumed":
      runs.set(event.runId, {
        ...current,
        status: "running",
        revision: event.revision,
        startedAt: current.startedAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
        waitingForChildren: false,
      });
      break;
    case "agent-run.turn-bound":
      runs.set(event.runId, {
        ...current,
        activeTurnId: event.turnId,
        revision: event.revision,
        updatedAt: event.occurredAt,
      });
      break;
    case "agent-run.waiting":
      runs.set(event.runId, {
        ...current,
        status: "waiting-for-input",
        revision: event.revision,
        updatedAt: event.occurredAt,
        waitingForChildren: event.reason === "children",
      });
      break;
    case "agent-run.result-succeeded":
      runs.set(event.runId, {
        ...current,
        status: "succeeded",
        revision: event.revision,
        updatedAt: event.occurredAt,
        finishedAt: event.occurredAt,
        usage: event.usage ?? current.usage,
        consumedTokens: current.consumedTokens + (event.usage?.totalTokens ?? 0),
        consumedEstimatedCostUsd:
          current.consumedEstimatedCostUsd + (event.usage?.estimatedCostUsd ?? 0),
        failure: undefined,
        waitingForChildren: false,
        activeTurnId: null,
      });
      break;
    case "agent-run.result-failed":
      runs.set(event.runId, {
        ...current,
        status: "failed",
        revision: event.revision,
        updatedAt: event.occurredAt,
        finishedAt: event.occurredAt,
        usage: event.usage ?? current.usage,
        consumedTokens: current.consumedTokens + (event.usage?.totalTokens ?? 0),
        consumedEstimatedCostUsd:
          current.consumedEstimatedCostUsd + (event.usage?.estimatedCostUsd ?? 0),
        failure: event.failure,
        waitingForChildren: false,
        activeTurnId: null,
      });
      break;
    case "agent-run.follow-up-revised":
      runs.set(event.runId, {
        ...current,
        status: "queued",
        revision: event.revision,
        updatedAt: event.occurredAt,
        finishedAt: null,
        usage: undefined,
        failure: undefined,
        waitingForChildren: false,
        integrationTargetThreadId: null,
        activeTurnId: null,
      });
      break;
    case "agent-run.cancelled":
      runs.set(event.runId, {
        ...current,
        status: "cancelled",
        revision: event.revision,
        updatedAt: event.occurredAt,
        finishedAt: event.occurredAt,
        waitingForChildren: false,
        activeTurnId: null,
      });
      break;
    case "agent-run.integration-started":
      runs.set(event.runId, {
        ...current,
        status: "integrating",
        revision: event.revision,
        updatedAt: event.occurredAt,
        integrationTargetThreadId: event.targetThreadId,
        failure: undefined,
      });
      break;
    case "agent-run.integration-succeeded":
      runs.set(event.runId, {
        ...current,
        status: "integrated",
        revision: event.revision,
        updatedAt: event.occurredAt,
        finishedAt: event.occurredAt,
        failure: undefined,
      });
      break;
    case "agent-run.integration-conflicted":
      runs.set(event.runId, {
        ...current,
        status: "succeeded",
        revision: event.revision,
        updatedAt: event.occurredAt,
        integrationTargetThreadId: null,
        failure: event.failure,
      });
      break;
  }
  return { runs };
};

export const evolveAll = (
  state: AgentRunState,
  events: ReadonlyArray<AgentRunEvent>,
): AgentRunState => events.reduce(evolve, state);

const invariant = (
  command: AgentRunCommand,
  detail: string,
  reason?: AgentRunCommandInvariantError["reason"],
) =>
  Effect.fail(
    new AgentRunCommandInvariantError({
      commandType: command.type,
      runId: command.runId,
      ...(reason === undefined ? {} : { reason }),
      detail,
    }),
  );

const requireRun = (state: AgentRunState, command: AgentRunCommand) => {
  const run = "runId" in command ? state.runs.get(command.runId) : undefined;
  return run === undefined ? invariant(command, "The run does not exist.") : Effect.succeed(run);
};

const childSettledEvents = (
  state: AgentRunState,
  child: AgentRun,
  occurredAt: string,
): ReadonlyArray<AgentRunEvent> => {
  if (child.parentRunId === null || child.detached) return [];
  const parent = state.runs.get(child.parentRunId);
  if (!parent || parent.status !== "waiting-for-input" || !parent.waitingForChildren) return [];
  const hasOtherActiveAttachedChildren = [...state.runs.values()].some(
    (candidate) =>
      candidate.parentRunId === parent.id &&
      !candidate.detached &&
      candidate.id !== child.id &&
      !isTerminal(candidate),
  );
  return hasOtherActiveAttachedChildren
    ? []
    : [nextEvent({ type: "agent-run.resumed", ...withRevision(parent, occurredAt) })];
};

const parentWaitEvent = (
  state: AgentRunState,
  child: AgentRun,
  occurredAt: string,
): ReadonlyArray<AgentRunEvent> => {
  if (child.parentRunId === null || child.detached) return [];
  const parent = state.runs.get(child.parentRunId);
  if (!parent || isTerminal(parent) || parent.status === "waiting-for-input") return [];
  return [
    nextEvent({
      type: "agent-run.waiting",
      ...withRevision(parent, occurredAt),
      reason: "children",
    }),
  ];
};

const budgetDoesNotExpand = (child: AgentProfileBudgetsType, parent: AgentProfileBudgetsType) =>
  child.maxRuns <= parent.maxRuns &&
  child.maxConcurrency <= parent.maxConcurrency &&
  child.maxDepth <= parent.maxDepth &&
  child.maxWallTimeMinutes <= parent.maxWallTimeMinutes &&
  (parent.maxTotalTokens === undefined ||
    (child.maxTotalTokens !== undefined && child.maxTotalTokens <= parent.maxTotalTokens)) &&
  (parent.maxEstimatedCostUsd === undefined ||
    (child.maxEstimatedCostUsd !== undefined &&
      child.maxEstimatedCostUsd <= parent.maxEstimatedCostUsd));

/** Decides all events for one command. IDs and timestamps must be supplied by the caller. */
export const decide = Effect.fn("AgentRun.decide")(function* (
  state: AgentRunState,
  command: AgentRunCommand,
): Effect.fn.Return<ReadonlyArray<AgentRunEvent>, AgentRunCommandInvariantError> {
  switch (command.type) {
    case "agent-run.request": {
      if (state.runs.has(command.runId)) return yield* invariant(command, "Run ids are unique.");
      if (command.parentRunId === null) {
        return [
          nextEvent({
            type: "agent-run.requested",
            runId: command.runId,
            revision: 0,
            occurredAt: command.occurredAt,
            wallTimeOriginAt: command.occurredAt,
            profile: command.profile,
            budget: command.budget,
            parentRunId: null,
            rootRunId: command.runId,
            depth: 0,
            detached: command.detached,
            parentThreadId: command.parentThreadId,
            projectId: command.projectId,
            modelSelection: command.modelSelection,
            instanceId: command.instanceId,
            workspaceMode: command.workspaceMode,
          }),
        ];
      }
      const parent = state.runs.get(command.parentRunId);
      if (!parent) return yield* invariant(command, "The parent run does not exist.");
      if (isTerminal(parent))
        return yield* invariant(command, "Terminal runs cannot create children.");
      if (!budgetDoesNotExpand(command.budget, parent.budget))
        return yield* invariant(command, "A child budget may not exceed its parent budget.");
      const depth = parent.depth + 1;
      if (depth > parent.budget.maxDepth || depth > command.budget.maxDepth)
        return yield* invariant(
          command,
          "The lineage depth budget is exhausted.",
          "budget-exhausted",
        );
      const rootRuns = runsInLineage(state, parent.rootRunId);
      // A child inherits an effective budget for the entire lineage. Do not
      // create a thread that cannot spend another token or cent.
      if (
        command.budget.maxTotalTokens !== undefined &&
        totalTokens(rootRuns) >= command.budget.maxTotalTokens
      )
        return yield* invariant(
          command,
          "The total-token budget is exhausted.",
          "budget-exhausted",
        );
      if (
        command.budget.maxEstimatedCostUsd !== undefined &&
        totalEstimatedCostUsd(rootRuns) >= command.budget.maxEstimatedCostUsd
      )
        return yield* invariant(
          command,
          "The estimated-cost budget is exhausted.",
          "budget-exhausted",
        );
      if (rootRuns.length >= command.budget.maxRuns)
        return yield* invariant(
          command,
          "The lineage run budget is exhausted.",
          "budget-exhausted",
        );
      const parentBecomesWaiting = !command.detached && activeForConcurrency(parent);
      const activeCount =
        rootRuns.filter(activeForConcurrency).length - (parentBecomesWaiting ? 1 : 0);
      if (activeCount + 1 > command.budget.maxConcurrency)
        return yield* invariant(
          command,
          "The lineage concurrency budget is exhausted.",
          "budget-exhausted",
        );
      const requested = nextEvent({
        type: "agent-run.requested",
        runId: command.runId,
        revision: 0,
        occurredAt: command.occurredAt,
        wallTimeOriginAt:
          state.runs.get(parent.rootRunId)?.wallTimeOriginAt ?? parent.wallTimeOriginAt,
        profile: command.profile,
        budget: command.budget,
        parentRunId: parent.id,
        rootRunId: parent.rootRunId,
        depth,
        detached: command.detached,
        parentThreadId: command.parentThreadId,
        projectId: command.projectId,
        modelSelection: command.modelSelection,
        instanceId: command.instanceId,
        workspaceMode: command.workspaceMode,
      });
      const child = evolve(state, requested).runs.get(command.runId);
      if (!child) return yield* invariant(command, "Could not initialize requested child run.");
      return [...parentWaitEvent(state, child, command.occurredAt), requested];
    }
    case "agent-run.assign-child-thread": {
      const run = yield* requireRun(state, command);
      if (run.status !== "queued" || run.childThreadId !== null)
        return yield* invariant(
          command,
          "Only an unassigned queued run can receive a child thread.",
        );
      return [
        nextEvent({
          type: "agent-run.child-thread-assigned",
          ...withRevision(run, command.occurredAt),
          childThreadId: command.childThreadId,
        }),
      ];
    }
    case "agent-run.start": {
      const run = yield* requireRun(state, command);
      if (run.status !== "queued" || run.childThreadId === null)
        return yield* invariant(command, "Only an assigned queued run can start.");
      return [nextEvent({ type: "agent-run.started", ...withRevision(run, command.occurredAt) })];
    }
    case "agent-run.bind-turn": {
      const run = yield* requireRun(state, command);
      if (run.status !== "running" && run.status !== "waiting-for-input") return [];
      if (Date.parse(command.occurredAt) < Date.parse(run.updatedAt)) return [];
      if (run.activeTurnId === command.turnId) return [];
      if (run.activeTurnId !== null)
        return yield* invariant(
          command,
          "A running Agent run is already bound to a different provider turn.",
        );
      return [
        nextEvent({
          type: "agent-run.turn-bound",
          ...withRevision(run, command.occurredAt),
          turnId: command.turnId,
        }),
      ];
    }
    case "agent-run.wait": {
      const run = yield* requireRun(state, command);
      if (run.status !== "running")
        return yield* invariant(command, "Only a running run can wait for input.");
      return [
        nextEvent({
          type: "agent-run.waiting",
          ...withRevision(run, command.occurredAt),
          reason: "input",
        }),
      ];
    }
    case "agent-run.resume": {
      const run = yield* requireRun(state, command);
      if (run.status !== "waiting-for-input")
        return yield* invariant(command, "Only a waiting run can resume.");
      return [nextEvent({ type: "agent-run.resumed", ...withRevision(run, command.occurredAt) })];
    }
    case "agent-run.succeed": {
      const run = yield* requireRun(state, command);
      if (run.status !== "running" && run.status !== "waiting-for-input")
        return yield* invariant(command, "Only active runs can succeed.");
      if (wallTimeExceeded(run, command.occurredAt))
        return yield* invariant(command, "The wall-time budget is exhausted.", "budget-exhausted");
      const lineage = runsInLineage(state, run.rootRunId);
      if (
        run.budget.maxTotalTokens !== undefined &&
        totalTokens(lineage) + (command.usage?.totalTokens ?? 0) > run.budget.maxTotalTokens
      )
        return yield* invariant(
          command,
          "The total-token budget is exhausted.",
          "budget-exhausted",
        );
      if (
        run.budget.maxEstimatedCostUsd !== undefined &&
        totalEstimatedCostUsd(lineage) + (command.usage?.estimatedCostUsd ?? 0) >
          run.budget.maxEstimatedCostUsd
      )
        return yield* invariant(
          command,
          "The estimated-cost budget is exhausted.",
          "budget-exhausted",
        );
      const event = nextEvent({
        type: "agent-run.result-succeeded",
        ...withRevision(run, command.occurredAt),
        ...(command.usage !== undefined ? { usage: command.usage } : {}),
      });
      return [event, ...childSettledEvents(state, run, command.occurredAt)];
    }
    case "agent-run.fail": {
      const run = yield* requireRun(state, command);
      if (isTerminal(run)) return yield* invariant(command, "Terminal runs cannot fail again.");
      const event = nextEvent({
        type: "agent-run.result-failed",
        ...withRevision(run, command.occurredAt),
        failure: command.failure,
        ...(command.usage !== undefined ? { usage: command.usage } : {}),
      });
      return [event, ...childSettledEvents(state, run, command.occurredAt)];
    }
    case "agent-run.follow-up": {
      const run = yield* requireRun(state, command);
      if (run.status !== "succeeded")
        return yield* invariant(
          command,
          "Only a successful result can be revised with a follow-up.",
        );
      if (wallTimeExceeded(run, command.occurredAt))
        return yield* invariant(command, "The wall-time budget is exhausted.", "budget-exhausted");
      const lineage = runsInLineage(state, run.rootRunId);
      if (
        run.budget.maxTotalTokens !== undefined &&
        totalTokens(lineage) >= run.budget.maxTotalTokens
      )
        return yield* invariant(
          command,
          "The total-token budget is exhausted.",
          "budget-exhausted",
        );
      if (
        run.budget.maxEstimatedCostUsd !== undefined &&
        totalEstimatedCostUsd(lineage) >= run.budget.maxEstimatedCostUsd
      )
        return yield* invariant(
          command,
          "The estimated-cost budget is exhausted.",
          "budget-exhausted",
        );
      const parent = run.parentRunId === null ? undefined : state.runs.get(run.parentRunId);
      const parentBecomesWaiting =
        parent !== undefined && !run.detached && activeForConcurrency(parent);
      const activeCount =
        lineage.filter(activeForConcurrency).length - (parentBecomesWaiting ? 1 : 0);
      if (activeCount + 1 > run.budget.maxConcurrency)
        return yield* invariant(
          command,
          "The lineage concurrency budget is exhausted.",
          "budget-exhausted",
        );
      const event = nextEvent({
        type: "agent-run.follow-up-revised",
        ...withRevision(run, command.occurredAt),
        message: command.message,
      });
      const revised = evolve(state, event).runs.get(run.id);
      if (!revised) return yield* invariant(command, "Could not revise successful run.");
      return [...parentWaitEvent(state, revised, command.occurredAt), event];
    }
    case "agent-run.cancel": {
      const run = yield* requireRun(state, command);
      if (isTerminal(run)) return [];
      const event = nextEvent({
        type: "agent-run.cancelled",
        ...withRevision(run, command.occurredAt),
        ...(command.reason !== undefined ? { reason: command.reason } : {}),
      });
      return [event, ...childSettledEvents(state, run, command.occurredAt)];
    }
    case "agent-run.start-integration": {
      const run = yield* requireRun(state, command);
      if (run.status !== "succeeded")
        return yield* invariant(command, "Only a successful run can start integration.");
      const targetThreadId = command.targetThreadId ?? run.childThreadId;
      if (targetThreadId === null)
        return yield* invariant(command, "Integration needs a target thread.");
      return [
        nextEvent({
          type: "agent-run.integration-started",
          ...withRevision(run, command.occurredAt),
          targetThreadId,
        }),
      ];
    }
    case "agent-run.succeed-integration": {
      const run = yield* requireRun(state, command);
      if (run.status !== "integrating")
        return yield* invariant(command, "Only an integrating run can finish integration.");
      return [
        nextEvent({
          type: "agent-run.integration-succeeded",
          ...withRevision(run, command.occurredAt),
        }),
      ];
    }
    case "agent-run.conflict-integration": {
      const run = yield* requireRun(state, command);
      if (run.status !== "integrating")
        return yield* invariant(command, "Only an integrating run can report a conflict.");
      return [
        nextEvent({
          type: "agent-run.integration-conflicted",
          ...withRevision(run, command.occurredAt),
          failure: command.failure,
        }),
      ];
    }
  }
});
