import type {
  BoardId,
  LaneEntryToken,
  LaneKey,
  MessageId,
  PipelineRunId,
  StepKey,
  StepOutcome,
  StepRunId,
  TicketAttachment,
  ThreadId,
  TicketId,
  TurnId,
  WorkflowEventId,
  WorkflowLane,
  WorkflowStep,
  WorkflowStepUsage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ApprovalGate } from "../Services/ApprovalGate.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { CapturedStepOutputReader } from "../Services/CapturedStepOutputReader.ts";
import { WorkflowEventStoreError, WorkflowEventStoreErrorCode } from "../Services/Errors.ts";
import { PredicateEvaluator } from "../Services/PredicateEvaluator.ts";
import { ProviderDispatchOutbox } from "../Services/ProviderDispatchOutbox.ts";
import { ProviderResponsePort } from "../Services/ProviderResponsePort.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor } from "../Services/StepExecutor.ts";
import { StepUsageReader } from "../Services/StepUsageReader.ts";
import { TurnStateReader, type TurnState } from "../Services/TurnStateReader.ts";
import { WorkflowAgentSessionStore } from "../Services/WorkflowAgentSessionStore.ts";
import {
  WorkflowEngine,
  type RecoveredStepResult,
  type WorkflowEngineShape,
} from "../Services/WorkflowEngine.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import {
  WorkflowEventStore,
  type PersistedWorkflowEvent,
  type WorkflowEventInput,
} from "../Services/WorkflowEventStore.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import {
  WorkflowRoutingContextBuilder,
  type WorkflowRoutingContext,
} from "../Services/WorkflowRoutingContextBuilder.ts";
import { MAX_TICKET_MESSAGE_BODY_LENGTH, truncateTicketMessageBody } from "../ticketMessageBody.ts";

type PipelineResult = "success" | "failure" | "blocked";
type StepResult = "completed" | "failed" | "blocked";
type RouteSource = "step_on" | "lane_transition" | "lane_on";
type MoveReason = "manual" | "routed" | "initial" | "external";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const toEngineSqlError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "workflow engine sql failed", cause });
const wrapSql = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toEngineSqlError));

const alreadyStoppedProviderErrorTags = new Set([
  "ProviderSessionNotFoundError",
  "ProviderAdapterSessionNotFoundError",
  "ProviderAdapterSessionClosedError",
]);

const providerErrorTag = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) {
    return null;
  }
  const tag = (cause as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : null;
};

const isAlreadyStoppedProviderError = (cause: unknown) => {
  const tag = providerErrorTag(cause);
  if (tag !== null && alreadyStoppedProviderErrorTags.has(tag)) {
    return true;
  }
  if (!(cause instanceof Error)) {
    return false;
  }
  return /(?:no active (?:provider )?(?:session|turn)|unknown provider thread|unknown .* adapter thread|adapter thread is closed)/i.test(
    cause.message,
  );
};

const providerCleanupAttempt = <A, E>(
  effect: Effect.Effect<A, E>,
  message: string,
): Effect.Effect<WorkflowEventStoreError | null> =>
  effect.pipe(
    Effect.as(null),
    Effect.catch((cause) =>
      isAlreadyStoppedProviderError(cause)
        ? Effect.succeed(null)
        : Effect.succeed(new WorkflowEventStoreError({ message, cause })),
    ),
  );

const stepCompletedPayload = (
  stepRunId: StepRunId,
  output?: unknown,
  usage?: WorkflowStepUsage,
) => ({
  stepRunId,
  ...(output === undefined ? {} : { output }),
  ...(usage === undefined ? {} : { usage }),
});

const stepFailedPayload = (
  stepRunId: StepRunId,
  error: string,
  usage?: WorkflowStepUsage,
  retryable?: boolean,
) => ({
  stepRunId,
  error,
  ...(retryable === undefined ? {} : { retryable }),
  ...(usage === undefined ? {} : { usage }),
});

const MAX_TICKET_ANSWER_BODY_LENGTH = MAX_TICKET_MESSAGE_BODY_LENGTH;
const MAX_TICKET_ANSWER_ATTACHMENT_COUNT = 6;
const MAX_TICKET_ANSWER_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const SAFE_TICKET_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const SAFE_TICKET_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,/i;

type PendingWait = Extract<PersistedWorkflowEvent, { readonly type: "StepAwaitingUser" }>;
type StepStarted = Extract<PersistedWorkflowEvent, { readonly type: "StepStarted" }>;
type PipelineStarted = Extract<PersistedWorkflowEvent, { readonly type: "PipelineStarted" }>;
type TicketCreated = Extract<PersistedWorkflowEvent, { readonly type: "TicketCreated" }>;
type UnstampedWorkflowEventInput = WorkflowEventInput extends infer Event
  ? Event extends WorkflowEventInput
    ? Omit<Event, "eventId" | "occurredAt">
    : never
  : never;

interface ActivePipeline {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly laneEntryToken: LaneEntryToken;
}

interface StepTicketRow {
  readonly ticketId: TicketId;
}

interface StepAwaitingStateRow {
  readonly status: string;
  readonly providerResponseKind: "request" | "user-input" | null;
}

interface PipelineRunForTokenRow {
  readonly pipelineRunId: PipelineRunId;
}

interface ActiveProviderTurnRow {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
}

interface RouteDecision {
  readonly toLane: LaneKey;
  readonly source: RouteSource;
  readonly matchedTransitionIndex?: number;
}

interface CaptureTurn {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

interface PipelineStartAction {
  readonly ticketId: TicketId;
  readonly boardId: BoardId;
  readonly lane: WorkflowLane;
  readonly laneEntryToken: LaneEntryToken;
}

interface RoutedEnterLaneOptions {
  readonly routeDecision: RouteDecision;
  readonly contextSnapshot: WorkflowRoutingContext;
  readonly expectedToken: LaneEntryToken;
  readonly pipelineRunId: PipelineRunId;
  readonly fromLane: WorkflowLane;
}

interface ExternalEnterLaneOptions {
  // The lane the matcher was evaluated against — a concurrent move makes the
  // decision stale and the external move becomes a no-op.
  readonly expectedFromLane: LaneKey;
  readonly routeEvent: UnstampedWorkflowEventInput;
  // Re-runs matcher resolution under the admission lock: a board save between
  // evaluation and commit may have removed the matcher or the target lane.
  readonly revalidate: Effect.Effect<boolean, WorkflowEventStoreError>;
}

const pipelineResultForStep = (result: StepResult): PipelineResult => {
  if (result === "completed") {
    return "success";
  }
  return result === "blocked" ? "blocked" : "failure";
};

const routingKeyForResult = (result: PipelineResult): "success" | "failure" | "blocked" =>
  result === "failure" ? "failure" : result;

const stepRouteDecision = (step: WorkflowStep, result: PipelineResult): RouteDecision | null => {
  const target = step.on?.[routingKeyForResult(result)];
  return target ? { toLane: target, source: "step_on" } : null;
};

interface StepRunOutcome {
  readonly result: StepResult;
  // User rejections (approval reject / awaiting-user reject) and explicit
  // cancellations must never be retried — the user already said no.
  readonly noRetry: boolean;
}

// Defensive clamp so a hand-edited workflow file cannot retry unboundedly;
// the linter enforces 2..5 at save time.
const MAX_RETRY_ATTEMPTS = 5;

const retryAttemptsForStep = (step: WorkflowStep): number => {
  const retryPolicy = step.type === "agent" || step.type === "script" ? step.retry : undefined;
  if (retryPolicy === undefined) {
    return 1;
  }
  return Math.min(Math.max(1, retryPolicy.maxAttempts), MAX_RETRY_ATTEMPTS);
};

const stepForAttempt = (step: WorkflowStep, attempt: number): WorkflowStep => {
  if (attempt === 1 || step.type !== "agent" || step.retry?.escalate === undefined) {
    return step;
  }
  const escalate = step.retry.escalate;
  return {
    ...step,
    agent: {
      ...step.agent,
      ...(escalate.instance === undefined ? {} : { instance: escalate.instance }),
      ...(escalate.model === undefined ? {} : { model: escalate.model }),
      ...(escalate.options === undefined ? {} : { options: escalate.options }),
    },
  };
};

const make = Effect.gen(function* () {
  const approvals = yield* ApprovalGate;
  const scriptCancels = yield* ScriptCancelRegistry;
  const committer = yield* WorkflowEventCommitter;
  const executor = yield* StepExecutor;
  const ids = yield* WorkflowIds;
  const predicates = yield* PredicateEvaluator;
  const read = yield* WorkflowReadModel;
  const registry = yield* BoardRegistry;
  const routingContextBuilder = yield* WorkflowRoutingContextBuilder;
  const sql = yield* SqlClient.SqlClient;
  const boardSemaphores = yield* SynchronizedRef.make<
    Map<string, { readonly semaphore: Semaphore.Semaphore; readonly permits: number }>
  >(new Map());
  const admissionSemaphores = yield* SynchronizedRef.make<Map<string, Semaphore.Semaphore>>(
    new Map(),
  );
  const runningPipelines = yield* SynchronizedRef.make<Map<string, ActivePipeline>>(new Map());
  // One recovery continuation per step run per process: the dispatch monitors
  // and the stranded-pipeline sweep can race to recover the same step.
  const recoveredStepClaims = yield* SynchronizedRef.make<Set<string>>(new Set());

  const getOptionalServices = Effect.context<never>().pipe(
    Effect.map((context) => ({
      providerResponses: Context.getOption(
        context as Context.Context<ProviderResponsePort>,
        ProviderResponsePort,
      ),
      providerDispatches: Context.getOption(
        context as Context.Context<ProviderDispatchOutbox>,
        ProviderDispatchOutbox,
      ),
      providerService: Context.getOption(
        context as Context.Context<ProviderService>,
        ProviderService,
      ),
      turnStateReader: Context.getOption(
        context as Context.Context<TurnStateReader>,
        TurnStateReader,
      ),
      capturedOutputs: Context.getOption(
        context as Context.Context<CapturedStepOutputReader>,
        CapturedStepOutputReader,
      ),
      usageReader: Context.getOption(context as Context.Context<StepUsageReader>, StepUsageReader),
      store: Context.getOption(context as Context.Context<WorkflowEventStore>, WorkflowEventStore),
      agentSessions: Context.getOption(
        context as Context.Context<WorkflowAgentSessionStore>,
        WorkflowAgentSessionStore,
      ),
    })),
  );

  // Best-effort live stop of a set of stored agent-session threads. `stopSession`
  // is a NON-rollbackable live side effect (it kills the provider session AND
  // does a `directory.upsert` SQL write), so it MUST run OUTSIDE any transaction.
  // The public move path calls this in-band (no chunk tx is open). The unlocked
  // source-close/create path snapshots the threads in-tx and defers this to the
  // committer's post-commit phase (see `stopAgentSessionsForTicket`). Best-effort:
  // a missing provider or a stop error is swallowed.
  const stopAgentSessionThreads = (threadIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (threadIds.length === 0) {
        return;
      }
      const { providerService } = yield* getOptionalServices;
      if (Option.isNone(providerService)) {
        return;
      }
      const provider = providerService.value;
      yield* Effect.forEach(
        threadIds,
        (threadId) =>
          providerCleanupAttempt(
            provider.stopSession({ threadId: threadId as ThreadId }),
            "workflow agent session stop failed",
          ),
        { discard: true },
      );
    });

  // A terminal lane is the ticket's resting place: its per-agent sessions can
  // never be resumed again, so drop the stored rows (tx-safe SQL) and — on the
  // public path — stop their live provider sessions. This MUST NOT fail the lane
  // transition — a missing store, a provider error, or a delete failure is
  // swallowed.
  //
  // `stopProviderSessions` gates the live `stopSession` calls. The public move
  // runs them IN-BAND (true) because no chunk transaction is open. The unlocked
  // source committer path passes `false`: only the tx-safe `deleteByTicket` runs
  // here (inside the chunk tx), and the committer collects the threads BEFORE the
  // close and stops them in its POST-COMMIT phase, so the non-rollbackable live
  // stop never runs inside the chunk transaction (mirrors how `boardDeletion`
  // lists-before / deletes-in-tx / stops-after-commit).
  const tearDownTicketAgentSessions = (ticketId: TicketId, stopProviderSessions: boolean) =>
    Effect.gen(function* () {
      const { agentSessions } = yield* getOptionalServices;
      if (Option.isNone(agentSessions)) {
        return;
      }
      const sessions = agentSessions.value;
      if (stopProviderSessions) {
        const rows = yield* sessions.listByTicket(ticketId).pipe(Effect.orElseSucceed(() => []));
        yield* stopAgentSessionThreads(rows.map((row) => row.threadId));
      }
      yield* sessions.deleteByTicket(ticketId).pipe(Effect.catch(() => Effect.void));
    });

  const ticketIdForStepRun = (stepRunId: StepRunId) =>
    wrapSql(sql<StepTicketRow>`
      SELECT ticket_id AS "ticketId"
      FROM projection_step_run
      WHERE step_run_id = ${stepRunId}
      UNION ALL
      SELECT ticket_id AS "ticketId"
      FROM workflow_events
      WHERE event_type = 'StepAwaitingUser'
        AND json_extract(payload_json, '$.stepRunId') = ${stepRunId}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0]?.ticketId ?? null));

  const awaitingStateForStepRun = (stepRunId: StepRunId) =>
    wrapSql(sql<StepAwaitingStateRow>`
      SELECT
        status,
        provider_response_kind AS "providerResponseKind"
      FROM projection_step_run
      WHERE step_run_id = ${stepRunId}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const readStoredEventsForStep = (stepRunId: StepRunId) =>
    Effect.gen(function* () {
      const { store } = yield* getOptionalServices;
      if (Option.isNone(store)) {
        return null;
      }

      const ticketId = yield* ticketIdForStepRun(stepRunId);
      if (ticketId === null) {
        return null;
      }

      return yield* Stream.runCollect(store.value.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
    });

  const pendingWaitInEvents = (
    events: ReadonlyArray<PersistedWorkflowEvent>,
    stepRunId: StepRunId,
  ) => {
    let pending: PendingWait | null = null;
    for (const event of events) {
      if (event.type === "StepAwaitingUser" && event.payload.stepRunId === stepRunId) {
        pending = event;
        continue;
      }
      if (event.type === "StepUserResolved" && event.payload.stepRunId === stepRunId) {
        pending = null;
      }
    }
    return pending;
  };

  const isLiveProviderUserInputWait = (pending: PendingWait, state: TurnState) => {
    if (
      state._tag !== "awaiting_user" ||
      state.providerResponseKind !== "user-input" ||
      pending.payload.providerResponseKind !== "user-input" ||
      pending.payload.providerThreadId === undefined ||
      pending.payload.providerRequestId === undefined
    ) {
      return false;
    }

    return (
      String(state.providerThreadId) === String(pending.payload.providerThreadId) &&
      String(state.providerRequestId) === String(pending.payload.providerRequestId) &&
      (state.providerQuestionId ?? null) === (pending.payload.providerQuestionId ?? null)
    );
  };

  const ensureLiveProviderUserInputWait = (pending: PendingWait | null) =>
    Effect.gen(function* () {
      if (
        pending?.payload.providerResponseKind !== "user-input" ||
        pending.payload.providerThreadId === undefined ||
        pending.payload.providerRequestId === undefined
      ) {
        return;
      }

      const { providerDispatches, turnStateReader } = yield* getOptionalServices;
      if (Option.isNone(turnStateReader)) {
        if (Option.isSome(providerDispatches)) {
          return yield* new WorkflowEventStoreError({
            message:
              "provider user-input request is not live yet; retry after recovery refreshes it",
          });
        }
        return;
      }

      const state = yield* turnStateReader.value.read(pending.payload.providerThreadId);
      if (isLiveProviderUserInputWait(pending, state)) {
        return;
      }

      return yield* new WorkflowEventStoreError({
        message: "provider user-input request is not live yet; retry after recovery refreshes it",
      });
    });

  const hasTerminalStepEvent = (
    events: ReadonlyArray<PersistedWorkflowEvent>,
    stepRunId: StepRunId,
  ) =>
    events.some(
      (event) =>
        (event.type === "StepCompleted" ||
          event.type === "StepFailed" ||
          event.type === "StepBlocked") &&
        event.payload.stepRunId === stepRunId,
    );

  const hasPipelineCompletedEvent = (
    events: ReadonlyArray<PersistedWorkflowEvent>,
    pipelineRunId: PipelineRunId,
  ) =>
    events.some(
      (event) =>
        event.type === "PipelineCompleted" && event.payload.pipelineRunId === pipelineRunId,
    );

  const pendingWaitFor = (stepRunId: StepRunId) =>
    Effect.gen(function* () {
      const events = yield* readStoredEventsForStep(stepRunId);
      if (events === null) {
        return null;
      }
      return pendingWaitInEvents(events, stepRunId);
    });

  const ticketAnswerAttachmentBytes = (attachments: ReadonlyArray<TicketAttachment>) =>
    attachments.reduce((total, attachment) => {
      if (attachment.kind !== "image") {
        return total;
      }
      return total + new TextEncoder().encode(attachment.dataUrl).byteLength;
    }, 0);

  const semaphoreFor = (boardId: BoardId, permits: number) =>
    SynchronizedRef.modifyEffect(boardSemaphores, (current) => {
      const key = boardId as string;
      const existing = current.get(key);
      if (existing && existing.permits === permits) {
        return Effect.succeed([existing.semaphore, current] as const);
      }

      // Effect semaphores are not resizable, so a changed maxConcurrentTickets
      // swaps in a fresh semaphore. In-flight holders drain on the old
      // semaphore and are invisible to the new one, so total concurrency can
      // transiently exceed the new limit (whether raised or lowered) until
      // they finish — bounded by the previously running pipelines and
      // self-correcting, which is accepted here.
      return Semaphore.make(permits).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(key, { semaphore, permits });
          return [semaphore, next] as const;
        }),
      );
    });

  const admissionSemaphoreFor = (boardId: BoardId) =>
    SynchronizedRef.modifyEffect(admissionSemaphores, (current) => {
      const key = boardId as string;
      const existing = current.get(key);
      if (existing) {
        return Effect.succeed([existing, current] as const);
      }

      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(key, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const withAdmissionLock = <A, E, R>(
    boardId: BoardId,
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const semaphore = yield* admissionSemaphoreFor(boardId);
      return yield* semaphore.withPermits(1)(body);
    });

  // Public exposure of the per-board admission semaphore (the WIP read-decide
  // serializer). Reuses the SAME `admissionSemaphores` instance via
  // `withAdmissionLock` — there is no second semaphore map. The source committer
  // MUST wrap its chunk in this (OUTER) -> the board save lock (INNER) -> the
  // transaction, matching the public enterLane lock order (admission->save), so
  // its sync admits serialize against concurrent user moves and cannot violate a
  // WIP limit. The unlocked enterLane cores assume this is already held.
  const withBoardAdmissionLock: WorkflowEngineShape["withBoardAdmissionLock"] = (boardId, effect) =>
    withAdmissionLock(boardId, effect);

  const commit = (
    event: UnstampedWorkflowEventInput,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const eventId = yield* ids.eventId();
      yield* committer.commit({
        ...event,
        eventId: eventId as WorkflowEventId,
        occurredAt: (yield* nowIso) as never,
      } as WorkflowEventInput);
    });

  const commitMany = (
    events: ReadonlyArray<UnstampedWorkflowEventInput>,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const stamped: Array<WorkflowEventInput> = [];
      for (const event of events) {
        const eventId = yield* ids.eventId();
        stamped.push({
          ...event,
          eventId: eventId as WorkflowEventId,
          occurredAt: (yield* nowIso) as never,
        } as WorkflowEventInput);
      }
      yield* committer.commitMany(stamped);
    });

  const userInputPromptMessageEvent = (
    ticketId: TicketId,
    stepRunId: StepRunId,
    body: string,
  ): Effect.Effect<UnstampedWorkflowEventInput, never> =>
    Effect.gen(function* () {
      const messageId = yield* ids.messageId();
      const createdAt = yield* nowIso;
      return {
        type: "TicketMessagePosted",
        ticketId,
        payload: {
          messageId: messageId as MessageId,
          stepRunId,
          author: "agent",
          body: truncateTicketMessageBody(body),
          attachments: [],
          createdAt: createdAt as never,
        },
      } satisfies UnstampedWorkflowEventInput;
    });

  const awaitingUserEvents = (
    ticketId: TicketId,
    event: Extract<UnstampedWorkflowEventInput, { readonly type: "StepAwaitingUser" }>,
  ): Effect.Effect<ReadonlyArray<UnstampedWorkflowEventInput>, never> =>
    Effect.gen(function* () {
      if (event.payload.providerResponseKind !== "user-input") {
        return [event];
      }
      const message = yield* userInputPromptMessageEvent(
        ticketId,
        event.payload.stepRunId,
        event.payload.waitingReason,
      );
      return [event, message];
    });

  const currentToken = (ticketId: TicketId) =>
    read
      .getTicketDetail(ticketId)
      .pipe(Effect.map((detail) => detail?.ticket.currentLaneEntryToken ?? null));

  const evaluateTransition = (rule: unknown, context: WorkflowRoutingContext) =>
    predicates.evaluate(rule, context).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowEventStoreError({
            message: "workflow route predicate evaluation failed",
            cause,
          }),
      ),
    );

  const laneTransitionDecision = (
    lane: WorkflowLane,
    context: WorkflowRoutingContext,
  ): Effect.Effect<RouteDecision | null, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const transitions = lane.transitions ?? [];
      for (const [index, transition] of transitions.entries()) {
        const evaluation = yield* evaluateTransition(transition.when, context);
        if (evaluation.result) {
          return {
            toLane: transition.to,
            source: "lane_transition",
            matchedTransitionIndex: index,
          } satisfies RouteDecision;
        }
      }
      return null;
    });

  const laneOnDecision = (lane: WorkflowLane, result: PipelineResult): RouteDecision | null => {
    const target = lane.on?.[routingKeyForResult(result)];
    return target ? { toLane: target, source: "lane_on" } : null;
  };

  const routeDecisionEvent = (
    ticketId: TicketId,
    pipelineRunId: PipelineRunId,
    lane: WorkflowLane,
    decision: RouteDecision,
    contextSnapshot: WorkflowRoutingContext,
  ): UnstampedWorkflowEventInput =>
    ({
      type: "TicketRouteDecided",
      ticketId,
      payload: {
        pipelineRunId,
        fromLane: lane.key,
        toLane: decision.toLane,
        source: decision.source,
        ...(decision.matchedTransitionIndex === undefined
          ? {}
          : { matchedTransitionIndex: decision.matchedTransitionIndex }),
        contextSnapshot,
      },
    }) as UnstampedWorkflowEventInput;

  const clearRunningPipeline = (ticketId: TicketId, laneEntryToken: LaneEntryToken) =>
    SynchronizedRef.update(runningPipelines, (current) => {
      const key = ticketId as string;
      const active = current.get(key);
      if (!active || active.laneEntryToken !== laneEntryToken) {
        return current;
      }

      const next = new Map(current);
      next.delete(key);
      return next;
    });

  const interruptRunningPipeline = (ticketId: TicketId) =>
    Effect.gen(function* () {
      const active = yield* SynchronizedRef.modify(runningPipelines, (current) => {
        const key = ticketId as string;
        const existing = current.get(key) ?? null;
        if (!existing) {
          return [null, current] as const;
        }

        const next = new Map(current);
        next.delete(key);
        return [existing, next] as const;
      });
      if (active) {
        yield* Fiber.interrupt(active.fiber).pipe(Effect.ignore);
      }
    });

  const readStepUsage = (
    threadId: ThreadId | undefined,
  ): Effect.Effect<WorkflowStepUsage | undefined> =>
    Effect.gen(function* () {
      if (threadId === undefined) {
        return undefined;
      }
      const { usageReader } = yield* getOptionalServices;
      if (Option.isNone(usageReader)) {
        return undefined;
      }
      return yield* usageReader.value.read(threadId);
    });

  const awaitProviderTerminalForStep = (
    stepRunId: StepRunId,
    threadId: ThreadId,
    step?: WorkflowStep,
  ): Effect.Effect<RecoveredStepResult, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const { providerDispatches } = yield* getOptionalServices;
      if (Option.isNone(providerDispatches)) {
        return { _tag: "completed" } satisfies RecoveredStepResult;
      }

      const result = yield* providerDispatches.value.awaitStepTerminal(stepRunId, threadId);
      const usage = yield* readStepUsage(threadId);
      if (result.ok) {
        const completed = yield* completedResultForStep(stepRunId, step);
        return usage === undefined || completed._tag === "blocked"
          ? completed
          : { ...completed, usage };
      }
      if ("awaitingUser" in result) {
        return {
          _tag: "failed",
          error: "provider requested additional user input",
          ...(usage === undefined ? {} : { usage }),
        } satisfies RecoveredStepResult;
      }
      return {
        _tag: "failed",
        error: result.error ?? "turn failed",
        ...(usage === undefined ? {} : { usage }),
      } satisfies RecoveredStepResult;
    });

  const completedResultForStep = (
    stepRunId: StepRunId,
    step: WorkflowStep | undefined,
    output?: unknown,
    captureTurn?: CaptureTurn,
  ): Effect.Effect<RecoveredStepResult, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      if (output !== undefined) {
        return { _tag: "completed", output } satisfies RecoveredStepResult;
      }
      if (step?.type !== "agent" || step.captureOutput !== true) {
        return { _tag: "completed" } satisfies RecoveredStepResult;
      }

      const { capturedOutputs } = yield* getOptionalServices;
      if (Option.isNone(capturedOutputs)) {
        return {
          _tag: "failed",
          error: "missing or invalid structured output",
        } satisfies RecoveredStepResult;
      }
      let turn = captureTurn;
      if (turn === undefined) {
        const { providerDispatches } = yield* getOptionalServices;
        if (Option.isSome(providerDispatches)) {
          turn = (yield* providerDispatches.value.getDispatchForStep(stepRunId)) ?? undefined;
        }
      }
      if (turn === undefined) {
        return {
          _tag: "failed",
          error: "missing or invalid structured output",
        } satisfies RecoveredStepResult;
      }

      return yield* capturedOutputs.value.read({ stepRunId, ...turn }).pipe(
        Effect.map((captured) => {
          if (captured === undefined) {
            return {
              _tag: "failed",
              error: "missing or invalid structured output",
            } satisfies RecoveredStepResult;
          }
          return { _tag: "completed", output: captured } satisfies RecoveredStepResult;
        }),
        Effect.orElseSucceed(
          () =>
            ({
              _tag: "failed",
              error: "structured output lookup failed",
            }) satisfies RecoveredStepResult,
        ),
      );
    });

  const runStep = (
    ticketId: TicketId,
    boardId: BoardId,
    pipelineRunId: PipelineRunId,
    step: WorkflowStep,
    laneEntryToken: LaneEntryToken,
    laneKey: LaneKey,
    laneStepKeys: ReadonlyArray<StepKey>,
    attempt: number,
  ): Effect.Effect<StepRunOutcome, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const stepRunId = yield* ids.stepRunId();
      yield* commit({
        type: "StepStarted",
        ticketId,
        payload: { pipelineRunId, stepRunId, stepKey: step.key, stepType: step.type, attempt },
      });

      if (step.type === "approval") {
        yield* commit({
          type: "StepAwaitingUser",
          ticketId,
          payload: { stepRunId, waitingReason: step.prompt ?? "Approval required" },
        });
        const approved = yield* approvals.await(stepRunId);
        yield* commit({ type: "StepUserResolved", ticketId, payload: { stepRunId } });
        if (!approved) {
          yield* commit({
            type: "StepFailed",
            ticketId,
            payload: stepFailedPayload(stepRunId, "rejected", undefined, false),
          });
          return { result: "failed", noRetry: true };
        }
        yield* commit({
          type: "StepCompleted",
          ticketId,
          payload: stepCompletedPayload(stepRunId),
        });
        return { result: "completed", noRetry: false };
      }

      const outcome = yield* (
        executor.execute({
          ticketId,
          boardId,
          pipelineRunId,
          stepRunId,
          laneEntryToken,
          laneKey,
          laneStepKeys,
          step,
        }) as Effect.Effect<StepOutcome, WorkflowEventStoreError>
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed<StepOutcome>({ _tag: "failed", error: formatError(error) }),
        ),
      );
      if (outcome._tag === "awaiting_user") {
        const awaitingEvent = {
          type: "StepAwaitingUser",
          ticketId,
          payload: {
            stepRunId,
            waitingReason: outcome.waitingReason,
            ...(outcome.providerThreadId === undefined
              ? {}
              : { providerThreadId: outcome.providerThreadId }),
            ...(outcome.providerRequestId === undefined
              ? {}
              : { providerRequestId: outcome.providerRequestId }),
            ...(outcome.providerResponseKind === undefined
              ? {}
              : { providerResponseKind: outcome.providerResponseKind }),
            ...(outcome.providerQuestionId === undefined
              ? {}
              : { providerQuestionId: outcome.providerQuestionId }),
          },
        } satisfies UnstampedWorkflowEventInput;
        yield* commitMany(yield* awaitingUserEvents(ticketId, awaitingEvent));
        const approved = yield* approvals.await(stepRunId);
        yield* commit({ type: "StepUserResolved", ticketId, payload: { stepRunId } });
        if (!approved) {
          yield* commit({
            type: "StepFailed",
            ticketId,
            payload: stepFailedPayload(stepRunId, "rejected", undefined, false),
          });
          return { result: "failed", noRetry: true };
        }
        if (outcome.providerThreadId !== undefined) {
          const terminalResult = yield* awaitProviderTerminalForStep(
            stepRunId,
            outcome.providerThreadId,
            step,
          );
          if (terminalResult._tag === "failed") {
            yield* commit({
              type: "StepFailed",
              ticketId,
              payload: stepFailedPayload(stepRunId, terminalResult.error, terminalResult.usage),
            });
            return { result: "failed", noRetry: false };
          }
          if (terminalResult._tag === "blocked") {
            yield* commit({
              type: "StepBlocked",
              ticketId,
              payload: { stepRunId, reason: terminalResult.reason },
            });
            return { result: "blocked", noRetry: false };
          }
          yield* commit({
            type: "StepCompleted",
            ticketId,
            payload: stepCompletedPayload(stepRunId, terminalResult.output, terminalResult.usage),
          });
          return { result: "completed", noRetry: false };
        }
        yield* commit({
          type: "StepCompleted",
          ticketId,
          payload: stepCompletedPayload(stepRunId),
        });
        return { result: "completed", noRetry: false };
      }
      if (outcome._tag === "failed") {
        yield* commit({
          type: "StepFailed",
          ticketId,
          payload: stepFailedPayload(
            stepRunId,
            outcome.error,
            outcome.usage,
            outcome.retryable === false ? false : undefined,
          ),
        });
        return { result: "failed", noRetry: outcome.retryable === false };
      }
      if (outcome._tag === "blocked") {
        yield* commit({
          type: "StepBlocked",
          ticketId,
          payload: { stepRunId, reason: outcome.reason },
        });
        return { result: "blocked", noRetry: false };
      }

      yield* commit({
        type: "StepCompleted",
        ticketId,
        payload: stepCompletedPayload(stepRunId, outcome.output, outcome.usage),
      });
      return { result: "completed", noRetry: false };
    });

  const runPipeline = (
    ticketId: TicketId,
    boardId: BoardId,
    lane: WorkflowLane,
    laneEntryToken: LaneEntryToken,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const definition = yield* registry.getDefinition(boardId);
      const permits = Math.max(1, definition?.settings?.maxConcurrentTickets ?? 3);
      const semaphore = yield* semaphoreFor(boardId, permits);
      yield* semaphore.withPermits(1)(runPipelineBody(ticketId, boardId, lane, laneEntryToken));
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const reason = `pipeline error: ${Cause.pretty(cause)}`;
        return Effect.logWarning("workflow pipeline orchestration failed", {
          boardId,
          laneEntryToken,
          laneKey: lane.key,
          reason,
          ticketId,
        }).pipe(
          Effect.flatMap(() =>
            commit({
              type: "TicketBlocked",
              ticketId,
              payload: { reason },
            }),
          ),
          Effect.catch(() => Effect.void),
        );
      }),
    );

  const completePipelineFrom = (
    ticketId: TicketId,
    boardId: BoardId,
    lane: WorkflowLane,
    laneEntryToken: LaneEntryToken,
    pipelineRunId: PipelineRunId,
    steps: ReadonlyArray<WorkflowStep>,
    startIndex: number,
    initialResult: PipelineResult,
    initialRouteDecision?: RouteDecision,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      let result: PipelineResult = initialResult;
      let routeDecision: RouteDecision | null = initialRouteDecision ?? null;
      const laneStepKeys = steps.map((s) => s.key);

      if (routeDecision === null) {
        for (const step of steps.slice(startIndex)) {
          if (result !== "success") {
            break;
          }
          const maxAttempts = retryAttemptsForStep(step);
          let attempt = 1;
          let stepOutcome = yield* runStep(
            ticketId,
            boardId,
            pipelineRunId,
            step,
            laneEntryToken,
            lane.key,
            laneStepKeys,
            attempt,
          );
          while (stepOutcome.result === "failed" && !stepOutcome.noRetry && attempt < maxAttempts) {
            attempt += 1;
            stepOutcome = yield* runStep(
              ticketId,
              boardId,
              pipelineRunId,
              stepForAttempt(step, attempt),
              laneEntryToken,
              lane.key,
              laneStepKeys,
              attempt,
            );
          }
          result = pipelineResultForStep(stepOutcome.result);
          routeDecision = stepRouteDecision(step, result);
          if (routeDecision !== null || result !== "success") {
            break;
          }
        }
      }

      const contextSnapshot = yield* routingContextBuilder.build({
        ticketId,
        pipelineRunId,
        result,
      });
      if (routeDecision === null) {
        routeDecision =
          (yield* laneTransitionDecision(lane, contextSnapshot)) ?? laneOnDecision(lane, result);
      }

      yield* commit({
        type: "PipelineCompleted",
        ticketId,
        payload: { pipelineRunId, result },
      });

      if (routeDecision !== null) {
        yield* enterLane(ticketId, boardId, routeDecision.toLane, "routed", {
          routeDecision,
          contextSnapshot,
          expectedToken: laneEntryToken,
          pipelineRunId,
          fromLane: lane,
        });
        return;
      }

      if (result !== "success") {
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = yield* currentToken(ticketId);
            if (token !== laneEntryToken) {
              return;
            }
            yield* commit({
              type: "TicketBlocked",
              ticketId,
              payload: { reason: `pipeline ${result} with no route` },
            });
          }),
        );
      }
    });

  const runPipelineBody = (
    ticketId: TicketId,
    boardId: BoardId,
    lane: WorkflowLane,
    laneEntryToken: LaneEntryToken,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const steps = lane.pipeline ?? [];
      if (steps.length === 0) {
        return;
      }

      const pipelineRunId = yield* ids.pipelineRunId();
      yield* commit({
        type: "PipelineStarted",
        ticketId,
        payload: { pipelineRunId, laneKey: lane.key, laneEntryToken },
      });

      yield* completePipelineFrom(
        ticketId,
        boardId,
        lane,
        laneEntryToken,
        pipelineRunId,
        steps,
        0,
        "success",
      );
    });

  // The ticket's current lane/token as stored in the projection. A pipeline
  // start may have been SNAPSHOTTED (e.g. by recoverBoardWip) before a
  // concurrent user/source move changed the ticket's lane entry token; this is
  // the authority for "is this start still current?".
  const ticketLaneTokenRow = (ticketId: TicketId) =>
    wrapSql(sql<{ readonly currentLaneKey: string; readonly currentLaneEntryToken: string | null }>`
      SELECT
        current_lane_key AS "currentLaneKey",
        current_lane_entry_token AS "currentLaneEntryToken"
      FROM projection_ticket
      WHERE ticket_id = ${ticketId}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const startPipeline = (
    ticketId: TicketId,
    boardId: BoardId,
    lane: WorkflowLane,
    laneEntryToken: LaneEntryToken,
  ) =>
    Effect.gen(function* () {
      const fiber = yield* SynchronizedRef.modifyEffect(runningPipelines, (current) =>
        Effect.gen(function* () {
          const key = ticketId as string;
          const active = current.get(key);
          if (active?.laneEntryToken === laneEntryToken) {
            return [null, current] as const;
          }

          // Stale-start guard: re-read the ticket and require its current lane
          // entry token AND lane key still match the start this call is for. A
          // snapshot-then-start path (recoverBoardWip) can race a user/source
          // move that re-tokened or re-laned the ticket between the snapshot and
          // here; starting then would run a pipeline for a lane the ticket has
          // already left (and the manual move could not interrupt it because it
          // was not yet in runningPipelines). This read runs INSIDE the
          // runningPipelines modify (and the caller holds the admission lock),
          // so a stale start is prevented atomically with the map insert.
          const row = yield* ticketLaneTokenRow(ticketId);
          if (
            row === null ||
            row.currentLaneEntryToken !== (laneEntryToken as string) ||
            row.currentLaneKey !== (lane.key as string)
          ) {
            return [null, current] as const;
          }

          return yield* runPipeline(ticketId, boardId, lane, laneEntryToken).pipe(
            Effect.ensuring(clearRunningPipeline(ticketId, laneEntryToken)),
            Effect.forkDetach({ startImmediately: false, uninterruptible: false }),
            Effect.map((fiber) => {
              const next = new Map(current);
              next.set(key, { fiber, laneEntryToken });
              return [fiber, next] as const;
            }),
          );
        }),
      );
      if (fiber !== null) {
        yield* Effect.yieldNow;
      }
    });

  const runPipelineStarts = (starts: ReadonlyArray<PipelineStartAction>) =>
    Effect.forEach(
      starts,
      (start) => startPipeline(start.ticketId, start.boardId, start.lane, start.laneEntryToken),
      { discard: true },
    );

  const collectStartAction = (
    starts: Array<PipelineStartAction>,
    ticketId: TicketId,
    boardId: BoardId,
    lane: WorkflowLane | null,
    laneEntryToken: LaneEntryToken,
  ) => {
    if (lane?.entry === "auto") {
      starts.push({ ticketId, boardId, lane, laneEntryToken });
    }
  };

  // How a lane-entry body persists its events. The locked emitter (default)
  // re-acquires the board save lock + opens a transaction per emission through
  // commit/commitMany, and publishes live ticket views — used by every existing
  // caller. The unlocked emitter (committer-driven Task 9 path) appends+projects
  // through the committer's appendManyUnlocked, which ASSUMES the caller already
  // holds the board save lock + an open transaction and does NOT publish; the
  // committer publishes after releasing the lock.
  type EmitEvents = (
    events: ReadonlyArray<UnstampedWorkflowEventInput>,
  ) => Effect.Effect<void, WorkflowEventStoreError>;

  const lockedEmit: EmitEvents = (events) =>
    events.length === 0
      ? Effect.void
      : events.length === 1
        ? commit(events[0] as UnstampedWorkflowEventInput)
        : commitMany(events);

  const stampEvent = (event: UnstampedWorkflowEventInput) =>
    Effect.gen(function* () {
      const eventId = yield* ids.eventId();
      return {
        ...event,
        eventId: eventId as WorkflowEventId,
        occurredAt: (yield* nowIso) as never,
      } as WorkflowEventInput;
    });

  // Append+project through the caller's already-held board save lock + open
  // transaction. Asserts (via the committer's contract) that the caller opened
  // the lock + tx — it never acquires either itself.
  const unlockedEmit: EmitEvents = (events) =>
    Effect.gen(function* () {
      if (events.length === 0) {
        return;
      }
      const stamped: Array<WorkflowEventInput> = [];
      for (const event of events) {
        stamped.push(yield* stampEvent(event));
      }
      yield* committer.appendManyUnlocked(stamped);
    });

  // Sweeps queued tickets into a lane up to its WIP limit. Runs under either
  // emitter — the locked public path (default `lockedEmit`) or the unlocked
  // source-committer path (caller passes `unlockedEmit`) — so it carries no
  // "Locked" suffix; the caller owns the serialization (admission lock).
  const admitNext = (
    boardId: BoardId,
    laneKey: LaneKey,
    emit: EmitEvents = lockedEmit,
  ): Effect.Effect<ReadonlyArray<PipelineStartAction>, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const lane = yield* registry.getLane(boardId, laneKey);
      const limit = lane?.wipLimit;
      if (lane === null || limit === undefined) {
        return [];
      }

      const starts: Array<PipelineStartAction> = [];
      while ((yield* read.countAdmittedInLane(boardId, laneKey)) < limit) {
        const queued = yield* read.oldestQueuedForLane(boardId, laneKey);
        if (queued === null) {
          break;
        }

        const laneEntryToken = yield* ids.token();
        const queuedTicketId = queued.ticketId as TicketId;
        yield* emit([
          {
            type: "TicketAdmitted",
            ticketId: queuedTicketId,
            payload: { lane: laneKey, laneEntryToken },
          },
        ]);
        collectStartAction(starts, queuedTicketId, boardId, lane, laneEntryToken);
      }

      return starts;
    });

  interface EnterLaneCoreOptions {
    readonly routedOptions?: RoutedEnterLaneOptions | undefined;
    readonly externalOptions?: ExternalEnterLaneOptions | undefined;
    // Persists the lane-entry events. Defaults to the locked emitter; the
    // committer-driven unlocked path passes unlockedEmit.
    readonly emit?: EmitEvents | undefined;
    // Serializes the WIP read-decide body. The board SAVE lock does NOT
    // serialize the WIP decision: it is taken only transiently at commit time
    // (after the admit/queue decision), so concurrent paths can both read
    // occupancy and both admit. The ADMISSION lock is what serializes the
    // read-decide. The public path therefore wraps the body in the board
    // admission lock. The unlocked path (the source committer) passes
    // `Effect.uninterruptible` here ONLY because it MUST already hold the
    // admission lock for the whole chunk via `withBoardAdmissionLock` (OUTER) ->
    // save lock (INNER) -> transaction. Taking the admission lock again here,
    // under the save lock, would invert that admission->save order and deadlock.
    readonly serialize?:
      | (<A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>)
      | undefined;
    // Runs the manual/external supersession (interrupt pipeline + cancel turns +
    // tombstone dispatches). Injected so the unlocked path reuses the identical
    // side effect.
    readonly supersedeRunningWork: Effect.Effect<void, WorkflowEventStoreError>;
    // When a terminal lane is entered, whether to call `provider.stopSession` for
    // the ticket's stored agent threads IN-BAND. Defaults to `true` for the public
    // move (no chunk tx is open). The unlocked source-committer callers pass
    // `false`: `stopSession` is a non-rollbackable live side effect that must not
    // run inside the chunk transaction, so only the tx-safe `deleteByTicket` runs
    // here and the committer defers the live stop to its post-commit phase.
    readonly stopProviderSessionsOnTeardown?: boolean | undefined;
  }

  // The in-lock / in-tx body of a lane entry: revalidation, WIP/admission/queue
  // decision, emit, and prior-lane sweep. Returns the pipeline starts to run
  // AFTER the lock (and, for the unlocked path, after the caller's transaction)
  // plus the outcome. Assumes the ticket already exists. Used by the public
  // enterLane (locked emit + admission lock) and by the committer-facing unlocked
  // ops (unlocked emit; they take no admission lock HERE only because the source
  // committer must already hold it via `withBoardAdmissionLock` — the save lock
  // alone does NOT serialize the WIP read-decide).
  const enterLaneCore = (
    ticketId: TicketId,
    boardId: BoardId,
    toLane: LaneKey,
    reason: MoveReason,
    options: EnterLaneCoreOptions,
  ): Effect.Effect<
    {
      readonly starts: ReadonlyArray<PipelineStartAction>;
      readonly acted: "moved" | "queued" | "none";
    },
    WorkflowEventStoreError
  > => {
    const { routedOptions, externalOptions, supersedeRunningWork } = options;
    const emit = options.emit ?? lockedEmit;
    const serialize =
      options.serialize ??
      (<A, E, R>(body: Effect.Effect<A, E, R>) =>
        withAdmissionLock(boardId, Effect.uninterruptible(body)));
    return serialize(
      Effect.gen(function* () {
        const none = {
          starts: [] as Array<PipelineStartAction>,
          acted: "none" as "moved" | "queued" | "none",
        };
        const detail = yield* read.getTicketDetail(ticketId);
        const priorLane = detail?.ticket.currentLaneKey as LaneKey | undefined;
        const priorWasAdmitted = detail !== null && detail.ticket.currentLaneEntryToken !== null;
        if (reason === "routed") {
          if (
            routedOptions === undefined ||
            detail?.ticket.currentLaneEntryToken !== routedOptions.expectedToken
          ) {
            return none;
          }
        }
        if (reason === "external") {
          if (
            externalOptions === undefined ||
            detail?.ticket.currentLaneKey !== (externalOptions.expectedFromLane as string)
          ) {
            return none;
          }
          // A board save may have removed the matcher or its target lane
          // between evaluation and this commit — re-resolve before acting.
          if (!(yield* externalOptions.revalidate)) {
            return none;
          }
          // Only a confirmed-fresh event may kill the ticket's running
          // work; stale events must no-op without side effects.
          yield* supersedeRunningWork;
        }
        const routeEvent =
          reason === "routed" && routedOptions !== undefined
            ? routeDecisionEvent(
                ticketId,
                routedOptions.pipelineRunId,
                routedOptions.fromLane,
                routedOptions.routeDecision,
                routedOptions.contextSnapshot,
              )
            : reason === "external" && externalOptions !== undefined
              ? externalOptions.routeEvent
              : null;
        const targetLane = yield* registry.getLane(boardId, toLane);
        // Defense-in-depth: a routed move may resolve to a lane key that no
        // longer exists in the current board def (e.g. the lane was removed via
        // the normal editor between route evaluation and this commit). Committing
        // a TicketMovedToLane into a non-existent lane would strand the ticket in
        // a phantom lane. Instead of moving, surface the ticket for human
        // attention via TicketBlocked: its pipeline is already done, so a silent
        // no-op would leave it admitted in its old lane with no signal. Block it
        // so attention_kind='blocked' fires through the existing path. We never
        // commit a move/queue into the phantom lane.
        if (reason === "routed" && targetLane === null) {
          yield* Effect.logWarning(
            "workflow routed move targets a lane missing from the current board def — blocking ticket",
            { boardId, ticketId, toLane },
          );
          yield* emit([
            {
              type: "TicketBlocked",
              ticketId,
              payload: {
                reason: `routed to lane '${toLane}' which no longer exists in the board definition`,
              },
            } as UnstampedWorkflowEventInput,
          ]);
          return none;
        }
        const limit = targetLane?.wipLimit;
        const admittedCount =
          limit === undefined ? 0 : yield* read.countAdmittedInLane(boardId, toLane);
        const selfInTarget = priorWasAdmitted && priorLane === toLane ? 1 : 0;
        const starts: Array<PipelineStartAction> = [];

        // A ticket waiting on dependencies never starts an auto lane's
        // pipeline — queue it; resolution of the last dependency
        // releases it through the admission sweep.
        const unresolvedDeps = detail?.ticket.unresolvedDependencyCount ?? 0;
        const dependencyGated = targetLane?.entry === "auto" && unresolvedDeps > 0;

        let acted: "moved" | "queued" = "moved";
        if ((limit !== undefined && admittedCount - selfInTarget >= limit) || dependencyGated) {
          acted = "queued";
          const queueEvent = {
            type: "TicketQueued",
            ticketId,
            payload: { lane: toLane },
          } as UnstampedWorkflowEventInput;
          yield* emit(routeEvent === null ? [queueEvent] : [routeEvent, queueEvent]);
        } else {
          const laneEntryToken = yield* ids.token();
          const moveEvent = {
            type: "TicketMovedToLane",
            ticketId,
            payload: { toLane, laneEntryToken, reason },
          } as UnstampedWorkflowEventInput;
          yield* emit(routeEvent === null ? [moveEvent] : [routeEvent, moveEvent]);
          collectStartAction(starts, ticketId, boardId, targetLane, laneEntryToken);
        }

        if (priorWasAdmitted && priorLane !== undefined && priorLane !== toLane) {
          starts.push(...(yield* admitNext(boardId, priorLane, emit)));
        }

        // Landing in a terminal lane is the end of the ticket's agent work:
        // tear down its stored per-agent sessions so resumable threads are not
        // left dangling. Shared across all enterLaneCore callers (enterLane,
        // closeTicketFromSourceUnlocked, createTicketAndEnterUnlocked). Queued
        // tickets have not actually entered the lane yet, so only on a move.
        // `deleteByTicket` (SQL) always runs in-band here (tx-safe). The live
        // `provider.stopSession` runs in-band ONLY on the public path; the
        // unlocked source-committer callers pass `false` and defer it to their
        // post-commit phase so it never runs inside the chunk transaction.
        if (acted === "moved" && targetLane?.terminal === true) {
          yield* tearDownTicketAgentSessions(
            ticketId,
            options.stopProviderSessionsOnTeardown ?? true,
          );
        }

        return { starts, acted };
      }),
    );
  };

  const enterLane = (
    ticketId: TicketId,
    boardId: BoardId,
    toLane: LaneKey,
    reason: MoveReason,
    routedOptions?: RoutedEnterLaneOptions,
    externalOptions?: ExternalEnterLaneOptions,
  ): Effect.Effect<"moved" | "queued" | "none", WorkflowEventStoreError> =>
    Effect.gen(function* () {
      // A manual move supersedes whatever the ticket was doing: stop live
      // provider turns so a stale agent cannot keep mutating the worktree
      // underneath the next lane's steps (e.g. a merge), and tombstone the
      // outbox rows so restart recovery never re-dispatches the stale work.
      // External events do the same, but only inside the admission lock once
      // the stale-lane guard has confirmed the event still applies.
      const supersedeRunningWork = Effect.gen(function* () {
        yield* interruptRunningPipeline(ticketId);
        yield* cancelActiveProviderTurnsForTicket(ticketId).pipe(Effect.catch(() => Effect.void));
        yield* abandonTicketDispatches(ticketId).pipe(Effect.catch(() => Effect.void));
      });
      if (reason === "manual") {
        yield* supersedeRunningWork;
      }

      const lockResult = yield* enterLaneCore(ticketId, boardId, toLane, reason, {
        routedOptions,
        externalOptions,
        supersedeRunningWork,
      });

      yield* runPipelineStarts(lockResult.starts);

      const movedLane = yield* registry.getLane(boardId, toLane);
      if (movedLane?.terminal === true) {
        // Resolution releases queued dependents; failure here must never undo
        // the move itself.
        yield* releaseDependents(ticketId).pipe(Effect.catch(() => Effect.void));
      }

      return lockResult.acted;
    });

  const moveToLane = (
    ticketId: TicketId,
    boardId: BoardId,
    toLane: LaneKey,
    reason: MoveReason,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    enterLane(ticketId, boardId, toLane, reason).pipe(Effect.asVoid);

  // Budgets are advisory caps — clamp junk client input instead of failing.
  const normalizeTokenBudget = (value: number | null | undefined): number | null | undefined => {
    if (value === undefined || value === null) {
      return value;
    }
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return Math.floor(value);
  };

  const validateDependsOn = (
    boardId: BoardId,
    ticketId: TicketId | null,
    dependsOn: ReadonlyArray<TicketId>,
  ): Effect.Effect<ReadonlyArray<TicketId>, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const unique = [...new Set(dependsOn)];
      if (ticketId !== null && unique.some((dep) => dep === ticketId)) {
        return yield* new WorkflowEventStoreError({
          message: "a ticket cannot depend on itself",
        });
      }
      for (const dep of unique) {
        const depDetail = yield* read.getTicketDetail(dep);
        if (depDetail === null) {
          return yield* new WorkflowEventStoreError({
            message: `dependency ticket ${dep} was not found`,
          });
        }
        if (depDetail.ticket.boardId !== (boardId as string)) {
          return yield* new WorkflowEventStoreError({
            message: "dependencies must be tickets on the same board",
          });
        }
      }
      if (ticketId !== null) {
        // Walk the existing edges from each new dependency; reaching the
        // ticket itself would close a cycle and deadlock both tickets. The
        // budget exists only to bound pathological graphs — exhausting it
        // with work remaining fails closed rather than letting a deep cycle
        // slip through.
        const seen = new Set<string>();
        const stack: string[] = [...unique];
        while (stack.length > 0) {
          if (seen.size > 500) {
            return yield* new WorkflowEventStoreError({
              message: "dependency graph is too deep to validate",
            });
          }
          const current = stack.pop();
          if (current === undefined) {
            break;
          }
          if (current === (ticketId as string)) {
            return yield* new WorkflowEventStoreError({
              message: "circular ticket dependencies are not allowed",
            });
          }
          if (seen.has(current)) {
            continue;
          }
          seen.add(current);
          const currentDetail = yield* read.getTicketDetail(current as TicketId);
          stack.push(...(currentDetail?.ticket.dependsOn ?? []));
        }
      }
      return unique;
    });

  const releaseDependents = (
    resolvedTicketId: TicketId,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const dependents = yield* read.listReleasableDependents(resolvedTicketId);
      for (const dependent of dependents) {
        yield* releaseTicketIfEligible(dependent.ticketId as TicketId);
      }
    });

  // Admit a queued ticket whose dependencies are all resolved. Used when a
  // dependency edit removes the last blocker and by restart recovery —
  // unlimited lanes are never swept by admitNext, so they need a
  // direct admit.
  const releaseTicketIfEligible = (
    ticketId: TicketId,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(ticketId);
      if (
        detail === null ||
        detail.ticket.queuedAt === null ||
        (detail.ticket.unresolvedDependencyCount ?? 0) > 0
      ) {
        return;
      }
      const boardId = detail.ticket.boardId as BoardId;
      const laneKey = detail.ticket.currentLaneKey as LaneKey;
      const lane = yield* registry.getLane(boardId, laneKey);
      if (lane === null) {
        return;
      }
      const starts = yield* withAdmissionLock(
        boardId,
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (lane.wipLimit !== undefined) {
              return yield* admitNext(boardId, laneKey);
            }
            const lockedDetail = yield* read.getTicketDetail(ticketId);
            if (
              lockedDetail === null ||
              lockedDetail.ticket.queuedAt === null ||
              (lockedDetail.ticket.unresolvedDependencyCount ?? 0) > 0
            ) {
              return [];
            }
            const laneEntryToken = yield* ids.token();
            yield* commit({
              type: "TicketAdmitted",
              ticketId,
              payload: { lane: laneKey, laneEntryToken },
            });
            const released: Array<PipelineStartAction> = [];
            collectStartAction(released, ticketId, boardId, lane, laneEntryToken);
            return released;
          }),
        ),
      );
      yield* runPipelineStarts(starts);
    });

  const createTicket: WorkflowEngineShape["createTicket"] = (input) =>
    Effect.gen(function* () {
      const dependsOn =
        input.dependsOn === undefined || input.dependsOn.length === 0
          ? []
          : yield* validateDependsOn(input.boardId, null, input.dependsOn);
      const ticketId = yield* ids.ticketId();
      const tokenBudget = normalizeTokenBudget(input.tokenBudget);
      yield* commit({
        type: "TicketCreated",
        ticketId,
        payload: {
          boardId: input.boardId,
          title: input.title,
          laneKey: input.initialLane,
          description: input.description,
          ...(tokenBudget === undefined || tokenBudget === null ? {} : { tokenBudget }),
        },
      } as UnstampedWorkflowEventInput);
      if (dependsOn.length > 0) {
        yield* commit({
          type: "TicketDependenciesSet",
          ticketId,
          payload: { dependsOn },
        });
      }
      yield* moveToLane(ticketId, input.boardId, input.initialLane, "initial");
      return ticketId;
    });

  const editTicket: WorkflowEngineShape["editTicket"] = (input) =>
    Effect.gen(function* () {
      const title = input.title === undefined ? undefined : input.title.trim();
      if (title !== undefined && title.length === 0) {
        return yield* new WorkflowEventStoreError({ message: "ticket title cannot be empty" });
      }
      if (input.dependsOn !== undefined) {
        const detail = yield* read.getTicketDetail(input.ticketId);
        if (detail === null) {
          return yield* new WorkflowEventStoreError({ message: "ticket not found" });
        }
        const boardId = detail.ticket.boardId as BoardId;
        // Validate and commit under the board's admission lock so two
        // concurrent edits cannot both validate against the old graph and
        // commit edges that only together form a cycle.
        yield* withAdmissionLock(
          boardId,
          Effect.gen(function* () {
            const dependsOn = yield* validateDependsOn(
              boardId,
              input.ticketId,
              input.dependsOn ?? [],
            );
            yield* commit({
              type: "TicketDependenciesSet",
              ticketId: input.ticketId,
              payload: { dependsOn },
            });
          }),
        );
        // Removing the last blocker must release the ticket right away —
        // there is no terminal move to trigger it otherwise.
        yield* releaseTicketIfEligible(input.ticketId).pipe(Effect.catch(() => Effect.void));
      }
      const tokenBudget = normalizeTokenBudget(input.tokenBudget);
      if (title === undefined && input.description === undefined && tokenBudget === undefined) {
        return;
      }
      yield* commit({
        type: "TicketEdited",
        ticketId: input.ticketId,
        payload: {
          ...(title === undefined ? {} : { title: title as never }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(tokenBudget === undefined ? {} : { tokenBudget }),
        },
      });
    });

  const validateTicketMessageInput = (
    input: {
      readonly text?: string | undefined;
      readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
    },
    subject: "message" | "answer",
  ): Effect.Effect<
    { readonly text: string; readonly attachments: ReadonlyArray<TicketAttachment> },
    WorkflowEventStoreError
  > =>
    Effect.gen(function* () {
      const text = input.text?.trim() ?? "";
      const attachments: ReadonlyArray<TicketAttachment> = input.attachments ?? [];
      if (text.length === 0 && attachments.length === 0) {
        return yield* new WorkflowEventStoreError({
          message: `ticket ${subject} requires text or an attachment`,
        });
      }
      if (text.length > MAX_TICKET_ANSWER_BODY_LENGTH) {
        return yield* new WorkflowEventStoreError({
          message: `ticket ${subject} body exceeds ${MAX_TICKET_ANSWER_BODY_LENGTH} characters`,
        });
      }
      if (attachments.length > MAX_TICKET_ANSWER_ATTACHMENT_COUNT) {
        return yield* new WorkflowEventStoreError({
          message: `ticket ${subject} supports at most ${MAX_TICKET_ANSWER_ATTACHMENT_COUNT} attachments`,
        });
      }
      if (attachments.some((attachment) => attachment.kind !== "image")) {
        return yield* new WorkflowEventStoreError({
          message: `ticket ${subject} attachments must be images`,
        });
      }
      if (
        attachments.some(
          (attachment) =>
            attachment.kind === "image" &&
            (!SAFE_TICKET_IMAGE_MIME_TYPES.has(attachment.mimeType) ||
              !SAFE_TICKET_IMAGE_DATA_URL.test(attachment.dataUrl)),
        )
      ) {
        return yield* new WorkflowEventStoreError({
          message: `ticket ${subject} image attachments must use png, jpeg, gif, or webp data URLs`,
        });
      }
      if (ticketAnswerAttachmentBytes(attachments) > MAX_TICKET_ANSWER_ATTACHMENT_BYTES) {
        return yield* new WorkflowEventStoreError({
          message: `ticket ${subject} attachments exceed the 10 MiB encoded limit`,
        });
      }
      return { text, attachments };
    });

  const postTicketMessage: WorkflowEngineShape["postTicketMessage"] = (input) =>
    Effect.gen(function* () {
      const { text, attachments } = yield* validateTicketMessageInput(input, "message");
      const detail = yield* read.getTicketDetail(input.ticketId);
      if (!detail) {
        return yield* new WorkflowEventStoreError({ message: "ticket not found" });
      }
      const messageId = yield* ids.messageId();
      yield* commit({
        type: "TicketMessagePosted",
        ticketId: input.ticketId,
        payload: {
          messageId,
          author: "user",
          body: text,
          attachments,
          createdAt: (yield* nowIso) as never,
        },
      });
    });

  const editTicketMessage: WorkflowEngineShape["editTicketMessage"] = (input) =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(input.ticketId);
      if (!detail) {
        return yield* new WorkflowEventStoreError({ message: "ticket not found" });
      }
      const { text } = yield* validateTicketMessageInput({ text: input.body }, "message");
      const target = detail.messages.find((m) => m.messageId === input.messageId);
      if (!target) {
        return yield* new WorkflowEventStoreError({ message: "message not found" });
      }
      // Only a user's own free-standing comment is editable: agent messages and
      // user answers bound to a step run (stepRunId set) carry provider-side
      // state we must not retroactively rewrite.
      if (target.author !== "user" || target.stepRunId != null) {
        return yield* new WorkflowEventStoreError({
          message: "only your own comments can be edited",
        });
      }
      yield* commit({
        type: "TicketMessageEdited",
        ticketId: input.ticketId,
        payload: {
          messageId: input.messageId,
          body: text,
          editedAt: (yield* nowIso) as never,
        },
      });
    });

  const answerTicketStep: WorkflowEngineShape["answerTicketStep"] = (input) =>
    Effect.gen(function* () {
      const { text, attachments } = yield* validateTicketMessageInput(input, "answer");
      // Provider responses are text-only, so an attachment-only answer could
      // never resume the awaiting step — reject before committing anything.
      if (text.length === 0) {
        return yield* new WorkflowEventStoreError({
          message: "answering an awaiting step requires text — add a note alongside attachments",
        });
      }

      const ticketId = yield* ticketIdForStepRun(input.stepRunId);
      if (ticketId === null) {
        // Fail (don't silently succeed): a stale/unknown stepRunId means the
        // answer would be dropped, and the client must learn its answer never
        // landed instead of seeing a void "success".
        return yield* new WorkflowEventStoreError({
          message: `step run ${input.stepRunId} not found`,
        });
      }
      const awaitingState = yield* awaitingStateForStepRun(input.stepRunId);
      const pending = yield* pendingWaitFor(input.stepRunId);
      const responseKind =
        awaitingState === null
          ? pending?.payload.providerResponseKind
          : awaitingState.status === "awaiting_user"
            ? awaitingState.providerResponseKind
            : null;
      if (responseKind !== "user-input") {
        return yield* new WorkflowEventStoreError({
          message: "ticket answer requires an awaiting user-input step",
        });
      }
      yield* ensureLiveProviderUserInputWait(pending);

      const messageId = yield* ids.messageId();
      yield* commit({
        type: "TicketMessagePosted",
        ticketId,
        payload: {
          messageId,
          stepRunId: input.stepRunId,
          author: "user",
          body: text,
          attachments,
          createdAt: (yield* nowIso) as never,
        },
      });

      const { providerResponses } = yield* getOptionalServices;
      if (
        pending?.payload.providerThreadId &&
        pending.payload.providerRequestId &&
        pending.payload.providerResponseKind === "user-input" &&
        Option.isSome(providerResponses)
      ) {
        yield* providerResponses.value.respond({
          threadId: pending.payload.providerThreadId,
          requestId: pending.payload.providerRequestId,
          responseKind: pending.payload.providerResponseKind,
          approved: true,
          ...(pending.payload.providerQuestionId === undefined
            ? {}
            : { questionId: pending.payload.providerQuestionId }),
          text,
        });
      }

      if (pending?.payload.providerResponseKind !== "user-input") {
        return;
      }
      const resumedLiveWaiter = yield* approvals.resolve(input.stepRunId, true);
      if (!resumedLiveWaiter) {
        yield* continueRecoveredApproval(pending, true);
      }
    });

  const moveTicket: WorkflowEngineShape["moveTicket"] = (ticketId, toLane) =>
    Effect.gen(function* () {
      const currentDetail = yield* read.getTicketDetail(ticketId);
      if (!currentDetail) {
        // Fail (don't silently succeed): a deleted/unknown ticket id must
        // surface to the caller, not look like a successful manual move.
        return yield* new WorkflowEventStoreError({
          message: `ticket ${ticketId} not found`,
        });
      }
      yield* moveToLane(ticketId, currentDetail.ticket.boardId as BoardId, toLane, "manual");
    });

  // ---------------------------------------------------------------------------
  // Committer-facing UNLOCKED engine ops (Task 9 work-source syncer). EVERY one
  // of these ASSUMES the caller already holds the board save lock for the
  // ticket's board AND is inside an open `sql.withTransaction`, AND — for any op
  // that makes a WIP admit/queue decision — already holds the board ADMISSION
  // lock via `withBoardAdmissionLock` (OUTER) wrapping the save lock (INNER)
  // wrapping the transaction. They never acquire the save lock, never open a
  // transaction, and never take the admission lock themselves: the save lock is
  // taken only transiently at commit time and does NOT serialize the WIP
  // read-decide, so the committer must hold the admission lock to be WIP-safe
  // against concurrent public enterLane moves. Calling the public
  // commit/commitMany/enterLane/moveTicket from here would deadlock the
  // non-reentrant save lock or nest the transaction. Pipeline starts are forked
  // detached (non-blocking) so they merely queue behind the save lock the
  // caller still holds and run once it is released.
  // ---------------------------------------------------------------------------

  // Post-tx provider cancellation for a source-closed ticket. Does ONLY the live
  // side effects — interrupt the running pipeline fiber and cancel the provider
  // turns — and performs NO DB writes (the in-tx close already tombstoned the
  // dispatch outbox rows). Idempotent: interrupting an already-cleared fiber or
  // cancelling an absent/stopped session is a no-op. The `turns` snapshot is
  // captured by the committer INSIDE the chunk tx (before the tombstone hid the
  // pending/started rows) and replayed here after the tx commits.
  const supersedeProviderWorkForTicket: WorkflowEngineShape["supersedeProviderWorkForTicket"] = (
    ticketId,
    turns,
  ) =>
    Effect.gen(function* () {
      yield* interruptRunningPipeline(ticketId);
      yield* cancelProviderTurns(turns).pipe(Effect.catch(() => Effect.void));
    });

  const cancellableProviderTurnsForTicket: WorkflowEngineShape["cancellableProviderTurnsForTicket"] =
    (ticketId) =>
      cancellableProviderDispatchesForTicket(ticketId).pipe(
        Effect.map((rows) => rows.map((row) => ({ threadId: row.threadId, turnId: row.turnId }))),
      );

  // Snapshot the ticket's stored per-agent session thread ids. The source
  // committer captures this INSIDE the chunk tx, BEFORE
  // `closeTicketFromSourceUnlocked`'s terminal teardown deletes the rows, then
  // replays it through `stopAgentSessionsForTicket` AFTER the tx commits — so the
  // non-rollbackable live `provider.stopSession` never runs inside the chunk
  // transaction (mirrors the turn-snapshot pattern above).
  const terminalAgentSessionThreadsForTicket: WorkflowEngineShape["terminalAgentSessionThreadsForTicket"] =
    (ticketId) =>
      Effect.gen(function* () {
        const { agentSessions } = yield* getOptionalServices;
        if (Option.isNone(agentSessions)) {
          return [];
        }
        const rows = yield* agentSessions.value
          .listByTicket(ticketId)
          .pipe(Effect.orElseSucceed(() => []));
        return rows.map((row) => row.threadId);
      });

  // POST-TX best-effort stop of the agent-session threads snapshotted by
  // `terminalAgentSessionThreadsForTicket`. The in-tx teardown already deleted the
  // rows; this only fires the live `provider.stopSession` (which kills the session
  // and does its own SQL write), so it MUST run after the chunk transaction
  // commits. Best-effort: errors are swallowed.
  const stopAgentSessionsForTicket: WorkflowEngineShape["stopAgentSessionsForTicket"] = (
    threadIds,
  ) => stopAgentSessionThreads(threadIds);

  const createTicketAndEnterUnlocked: WorkflowEngineShape["createTicketAndEnterUnlocked"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const ticketId = yield* ids.ticketId();
      yield* unlockedEmit([
        {
          type: "TicketCreated",
          ticketId,
          payload: {
            boardId: input.boardId,
            title: input.title,
            laneKey: input.destinationLane,
            ...(input.description === undefined ? {} : { description: input.description }),
          },
        } as UnstampedWorkflowEventInput,
      ]);
      // Pipeline starts are intentionally DROPPED here: starting a pipeline
      // commits through the locked path, which would open a transaction while
      // the caller's chunk transaction is still open (the SQLite connection has
      // a single global transaction). The committer (Task 9) is responsible for
      // triggering auto-lane pipeline starts (e.g. recoverBoardWip) AFTER it
      // closes the chunk transaction and releases the save lock.
      const { acted } = yield* enterLaneCore(
        ticketId,
        input.boardId,
        input.destinationLane,
        "initial",
        {
          emit: unlockedEmit,
          serialize: Effect.uninterruptible,
          supersedeRunningWork: Effect.void,
          // In-tx: only the tx-safe deleteByTicket runs here; never call the live
          // provider.stopSession inside the chunk transaction.
          stopProviderSessionsOnTeardown: false,
        },
      );
      return { ticketId, outcome: acted };
    });

  const closeTicketFromSourceUnlocked: WorkflowEngineShape["closeTicketFromSourceUnlocked"] = (
    ticketId,
    closedLane,
  ) =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(ticketId);
      if (detail === null) {
        return;
      }
      const boardId = detail.ticket.boardId as BoardId;
      const fromLane = detail.ticket.currentLaneKey as LaneKey;
      const routeEvent = {
        type: "TicketRouteDecided",
        ticketId,
        payload: {
          fromLane,
          toLane: closedLane,
          source: "work_source",
          // The event schema requires contextSnapshot; a work-source close has
          // no pipeline/event context, so record an empty snapshot.
          contextSnapshot: null,
        },
      } as UnstampedWorkflowEventInput;
      // Reuse the EXTERNAL move path so the close lands via the same stale-lane
      // guard, but the supersession here is DB-ONLY: it tombstones the ticket's
      // dispatch outbox rows (tx-safe — rolls back with the chunk if a later
      // delta fails). It does NOT interrupt the running pipeline fiber or call
      // provider interruptTurn/stopSession, because those are live side effects
      // that cannot be rolled back and must not run inside the chunk
      // transaction. The committer drives the fiber-interrupt + provider-cancel
      // AFTER the chunk commits, via supersedeProviderWorkForTicket. revalidate
      // succeeds unconditionally — the work source is the authority on closing,
      // there is no stale-matcher concern. Pipeline starts the close might admit
      // in the prior lane are dropped for the same single-transaction reason as
      // createTicketAndEnterUnlocked (closed lanes are terminal in practice; the
      // committer sweeps starts after the chunk).
      yield* enterLaneCore(ticketId, boardId, closedLane, "external", {
        emit: unlockedEmit,
        serialize: Effect.uninterruptible,
        supersedeRunningWork: abandonTicketDispatches(ticketId).pipe(
          Effect.catch(() => Effect.void),
        ),
        externalOptions: {
          expectedFromLane: fromLane,
          routeEvent,
          revalidate: Effect.succeed(true),
        },
        // A source's closedLane is lint-required to be terminal, so this reliably
        // hits the teardown branch INSIDE the committer's chunk transaction. Only
        // the tx-safe deleteByTicket may run here; `provider.stopSession` is a
        // non-rollbackable live side effect. The committer snapshots the threads
        // via `terminalAgentSessionThreadsForTicket` BEFORE this close and stops
        // them in its post-commit phase (alongside supersedeProviderWorkForTicket).
        stopProviderSessionsOnTeardown: false,
      });
    });

  const reopenTicketFromSourceUnlocked: WorkflowEngineShape["reopenTicketFromSourceUnlocked"] = (
    ticketId,
    destinationLane,
  ) =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(ticketId);
      if (detail === null) {
        return;
      }
      const boardId = detail.ticket.boardId as BoardId;
      const fromLane = detail.ticket.currentLaneKey as LaneKey;
      // Already where we'd route it (e.g. a redundant reopen) → nothing to do.
      if ((fromLane as string) === (destinationLane as string)) {
        return;
      }
      const routeEvent = {
        type: "TicketRouteDecided",
        ticketId,
        payload: {
          fromLane,
          toLane: destinationLane,
          source: "work_source",
          contextSnapshot: null,
        },
      } as UnstampedWorkflowEventInput;
      // Mirror closeTicketFromSourceUnlocked but route back to the destination
      // lane. No provider supersession (a reopen revives work, it does not cancel
      // it); the work source is authoritative so revalidate succeeds. Any auto-
      // lane pipeline start the destination admits is dropped (single-tx) and the
      // committer's post-commit recoverBoardWip sweep starts it.
      yield* enterLaneCore(ticketId, boardId, destinationLane, "external", {
        emit: unlockedEmit,
        serialize: Effect.uninterruptible,
        supersedeRunningWork: Effect.void,
        externalOptions: {
          expectedFromLane: fromLane,
          routeEvent,
          revalidate: Effect.succeed(true),
        },
        // A reopen target is not a terminal lane, so the teardown branch is not
        // expected to fire — but this is an in-tx caller, so never run the live
        // provider.stopSession in-band regardless (only the tx-safe deleteByTicket
        // may run inside the chunk transaction).
        stopProviderSessionsOnTeardown: false,
      });
    });

  const editTicketFieldsUnlocked: WorkflowEngineShape["editTicketFieldsUnlocked"] = (
    ticketId,
    fields,
  ) =>
    Effect.gen(function* () {
      // Mirror the locked editTicket: a whitespace-only TITLE is dropped rather
      // than written, so the projection never overwrites the stored title with
      // an empty string. (editTicket errors; here we silently OMIT the field —
      // the syncer must not blank a title and has no caller to surface an error
      // to.)
      // DESCRIPTION is treated differently: an empty-string description is a
      // VALID CLEAR (source-owned descriptions are authoritative), so when a
      // description is PROVIDED — including "" — it is emitted and written. Only
      // `undefined` (not provided) leaves the description unchanged. The guard
      // below therefore checks `=== undefined` (not falsiness) for description.
      const trimmed = fields.title === undefined ? undefined : fields.title.trim();
      const title = trimmed !== undefined && trimmed.length === 0 ? undefined : trimmed;
      if (title === undefined && fields.description === undefined) {
        return;
      }
      yield* unlockedEmit([
        {
          type: "TicketEdited",
          ticketId,
          payload: {
            ...(title === undefined ? {} : { title: title as never }),
            ...(fields.description === undefined ? {} : { description: fields.description }),
          },
        } as UnstampedWorkflowEventInput,
      ]);
    });

  const hasPipelineStartedForToken = (ticketId: TicketId, laneEntryToken: LaneEntryToken) =>
    wrapSql(sql<PipelineRunForTokenRow>`
      SELECT pipeline_run_id AS "pipelineRunId"
      FROM projection_pipeline_run
      WHERE ticket_id = ${ticketId}
        AND lane_entry_token = ${laneEntryToken}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows.length > 0));

  const cancellableProviderDispatchesForBoard = (boardId: BoardId) =>
    wrapSql(sql<ActiveProviderTurnRow>`
      SELECT DISTINCT
        outbox.thread_id AS "threadId",
        outbox.turn_id AS "turnId"
      FROM workflow_dispatch_outbox AS outbox
      INNER JOIN projection_ticket AS ticket
        ON ticket.ticket_id = outbox.ticket_id
      WHERE ticket.board_id = ${boardId}
        AND outbox.status IN ('pending', 'started')
      ORDER BY outbox.thread_id ASC, outbox.turn_id ASC
    `);

  const cancellableProviderDispatchesForTicket = (ticketId: TicketId) =>
    wrapSql(sql<ActiveProviderTurnRow>`
      SELECT DISTINCT
        thread_id AS "threadId",
        turn_id AS "turnId"
      FROM workflow_dispatch_outbox
      WHERE ticket_id = ${ticketId}
        AND status IN ('pending', 'started')
      ORDER BY thread_id ASC, turn_id ASC
    `);

  const cancelProviderTurns = (turns: ReadonlyArray<ActiveProviderTurnRow>) =>
    Effect.gen(function* () {
      const { providerService } = yield* getOptionalServices;
      if (Option.isNone(providerService)) {
        return;
      }
      yield* Effect.forEach(
        turns,
        (turn) =>
          Effect.gen(function* () {
            const interruptError =
              turn.turnId === null
                ? null
                : yield* providerCleanupAttempt(
                    providerService.value.interruptTurn({
                      threadId: turn.threadId,
                      turnId: turn.turnId,
                    }),
                    "workflow provider turn interrupt failed",
                  );

            const stopError = yield* providerCleanupAttempt(
              providerService.value.stopSession({ threadId: turn.threadId }),
              "workflow provider session stop failed",
            );

            const cleanupError = interruptError ?? stopError;
            if (cleanupError !== null) {
              return yield* cleanupError;
            }
          }),
        { discard: true },
      );
    });

  const abandonTicketDispatches = (ticketId: TicketId) =>
    Effect.gen(function* () {
      const confirmedAt = yield* nowIso;
      yield* wrapSql(sql`
        UPDATE workflow_dispatch_outbox
        SET status = 'confirmed',
            confirmed_at = ${confirmedAt}
        WHERE ticket_id = ${ticketId}
          AND status IN ('pending', 'started')
      `);
    });

  const cancelActiveProviderTurns = (boardId: BoardId) =>
    Effect.gen(function* () {
      const turns = yield* cancellableProviderDispatchesForBoard(boardId);
      yield* cancelProviderTurns(turns);
    });

  const cancelActiveProviderTurnsForTicket = (ticketId: TicketId) =>
    Effect.gen(function* () {
      const turns = yield* cancellableProviderDispatchesForTicket(ticketId);
      yield* cancelProviderTurns(turns);
    });

  const recoverBoardWip: WorkflowEngineShape["recoverBoardWip"] = (boardId) =>
    Effect.gen(function* () {
      const definition = yield* registry.getDefinition(boardId);
      if (definition === null) {
        return;
      }

      for (const lane of definition.lanes) {
        yield* withAdmissionLock(boardId, Effect.uninterruptible(admitNext(boardId, lane.key)));
      }

      const tickets = yield* read.listTickets(boardId);
      // admitNext only sweeps WIP-limited lanes; a crash between a
      // dependency landing and its dependents being released would otherwise
      // strand queued tickets in unlimited auto lanes forever.
      for (const ticket of tickets) {
        if (ticket.queuedAt === null || (ticket.unresolvedDependencyCount ?? 0) > 0) {
          continue;
        }
        const lane = yield* registry.getLane(boardId, ticket.currentLaneKey as LaneKey);
        if (lane?.entry !== "auto" || lane.wipLimit !== undefined) {
          continue;
        }
        yield* releaseTicketIfEligible(ticket.ticketId as TicketId).pipe(
          Effect.catch(() => Effect.void),
        );
      }
      for (const ticket of tickets) {
        if (ticket.currentLaneEntryToken === null) {
          continue;
        }
        const lane = yield* registry.getLane(boardId, ticket.currentLaneKey as LaneKey);
        if (lane?.entry !== "auto") {
          continue;
        }
        const laneEntryToken = ticket.currentLaneEntryToken as LaneEntryToken;
        const hasStarted = yield* hasPipelineStartedForToken(
          ticket.ticketId as TicketId,
          laneEntryToken,
        );
        if (!hasStarted) {
          yield* startPipeline(ticket.ticketId as TicketId, boardId, lane, laneEntryToken);
        }
      }
    });

  const ingestExternalEvent: WorkflowEngineShape["ingestExternalEvent"] = (input) =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(input.ticketId);
      if (detail === null || detail.ticket.boardId !== (input.boardId as string)) {
        return yield* new WorkflowEventStoreError({
          message: "ticket not found on this board",
          code: WorkflowEventStoreErrorCode.ticketNotOnBoard,
        });
      }
      const fromLaneKey = detail.ticket.currentLaneKey as LaneKey;
      // Read once; revalidate reuses this snapshot — do not re-read.
      // resolveTarget closes over the eventContext built below, so the lock-guarded
      // revalidate inside enterLane re-runs the same matcher against the same pr
      // context without a second DB read (design finding #1: single read prevents
      // desync between the initial evaluation and the revalidate recheck).
      const prState = yield* read.getTicketPrState(input.ticketId);
      const eventContext = {
        event: { name: input.name, payload: input.payload ?? null },
        pr: {
          ciState: prState?.lastCiState ?? null,
          reviewDecision: prState?.lastReviewDecision ?? null,
        },
      };
      const resolveTarget = Effect.gen(function* () {
        const lane = yield* registry.getLane(input.boardId, fromLaneKey);
        for (const matcher of lane?.onEvent ?? []) {
          if ((matcher.name as string) !== input.name) {
            continue;
          }
          if (matcher.when !== undefined) {
            const evaluation = yield* predicates.evaluate(matcher.when, eventContext).pipe(
              Effect.mapError(
                (cause) =>
                  new WorkflowEventStoreError({
                    message: "external event predicate evaluation failed",
                    cause,
                  }),
              ),
            );
            if (!evaluation.result) {
              continue;
            }
          }
          return matcher.to;
        }
        return null;
      });
      const target = yield* resolveTarget;
      if (target === null) {
        return { outcome: "noop" as const };
      }

      const routeEvent = {
        type: "TicketRouteDecided",
        ticketId: input.ticketId,
        payload: {
          fromLane: fromLaneKey,
          toLane: target,
          source: "external_event",
          contextSnapshot: eventContext,
        },
      } as UnstampedWorkflowEventInput;
      const acted = yield* enterLane(input.ticketId, input.boardId, target, "external", undefined, {
        expectedFromLane: fromLaneKey,
        routeEvent,
        revalidate: Effect.gen(function* () {
          if ((yield* resolveTarget) !== target) {
            return false;
          }
          return (yield* registry.getLane(input.boardId, target)) !== null;
        }),
      });
      if (acted === "none") {
        return { outcome: "noop" as const };
      }
      return { outcome: acted, toLane: target as string };
    });

  const runLane: WorkflowEngineShape["runLane"] = (ticketId) =>
    Effect.gen(function* () {
      const currentDetail = yield* read.getTicketDetail(ticketId);
      if (!currentDetail) {
        return;
      }

      const unresolvedDeps = currentDetail.ticket.unresolvedDependencyCount ?? 0;
      if (unresolvedDeps > 0) {
        return yield* new WorkflowEventStoreError({
          message: `ticket is waiting on ${unresolvedDeps} unresolved dependenc${
            unresolvedDeps === 1 ? "y" : "ies"
          }`,
        });
      }
      const lane = yield* registry.getLane(
        currentDetail.ticket.boardId as BoardId,
        currentDetail.ticket.currentLaneKey as LaneKey,
      );
      const token = yield* currentToken(ticketId);
      if (lane && token) {
        yield* startPipeline(
          ticketId,
          currentDetail.ticket.boardId as BoardId,
          lane,
          token as LaneEntryToken,
        );
      }
    });

  const recoveredStepContext = (
    events: ReadonlyArray<PersistedWorkflowEvent>,
    stepRunId: StepRunId,
  ) => {
    let stepStarted: StepStarted | null = null;
    let pipelineStarted: PipelineStarted | null = null;
    let ticketCreated: TicketCreated | null = null;

    for (const event of events) {
      if (event.type === "StepStarted" && event.payload.stepRunId === stepRunId) {
        stepStarted = event;
      }
    }
    if (!stepStarted) {
      return null;
    }

    for (const event of events) {
      if (event.type === "TicketCreated" && event.ticketId === stepStarted.ticketId) {
        ticketCreated = event;
      }
      if (
        event.type === "PipelineStarted" &&
        event.payload.pipelineRunId === stepStarted.payload.pipelineRunId
      ) {
        pipelineStarted = event;
      }
    }
    if (!pipelineStarted || !ticketCreated) {
      return null;
    }

    return { stepStarted, pipelineStarted, ticketCreated };
  };

  const completeRecoveredStepUnlocked = (
    stepRunId: StepRunId,
    result: RecoveredStepResult,
    captureTurn: { readonly threadId: ThreadId; readonly turnId: TurnId } | undefined,
    options?: { readonly allowRetry?: boolean },
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const events = yield* readStoredEventsForStep(stepRunId);
      if (events === null) {
        return;
      }

      const recovered = recoveredStepContext(events, stepRunId);
      if (
        !recovered ||
        hasPipelineCompletedEvent(events, recovered.pipelineStarted.payload.pipelineRunId)
      ) {
        return;
      }

      const boardId = recovered.ticketCreated.payload.boardId;
      const laneEntryToken = recovered.pipelineStarted.payload.laneEntryToken;
      const pipelineRunId = recovered.pipelineStarted.payload.pipelineRunId;
      // The board definition may have changed across the restart: a missing
      // lane or step must still resolve the pipeline run, or it pins the
      // ticket's WIP slot forever.
      const supersedePipeline = commitMany([
        {
          type: "PipelineCompleted",
          ticketId: recovered.stepStarted.ticketId,
          payload: { pipelineRunId, result: "superseded" },
        },
        // Surface the dead end instead of leaving the ticket "running"; the
        // user re-routes it manually once the board matches reality again.
        {
          type: "TicketBlocked",
          ticketId: recovered.stepStarted.ticketId,
          payload: { reason: "board definition changed while this step was recovering" },
        },
      ] as ReadonlyArray<UnstampedWorkflowEventInput>);
      const lane = yield* registry.getLane(boardId, recovered.pipelineStarted.payload.laneKey);
      if (!lane) {
        yield* supersedePipeline;
        return;
      }

      const steps = lane.pipeline ?? [];
      const currentStepIndex = steps.findIndex(
        (step) => step.key === recovered.stepStarted.payload.stepKey,
      );
      if (currentStepIndex < 0) {
        yield* supersedePipeline;
        return;
      }

      const recoveredStep = steps[currentStepIndex];
      let terminalResult =
        result._tag === "completed"
          ? yield* completedResultForStep(stepRunId, recoveredStep, result.output, captureTurn)
          : result;
      if (
        terminalResult._tag !== "blocked" &&
        terminalResult.usage === undefined &&
        captureTurn !== undefined
      ) {
        const usage = yield* readStepUsage(captureTurn.threadId);
        if (usage !== undefined) {
          terminalResult = { ...terminalResult, usage };
        }
      }

      if (!hasTerminalStepEvent(events, stepRunId)) {
        if (terminalResult._tag === "completed") {
          yield* commit({
            type: "StepCompleted",
            ticketId: recovered.stepStarted.ticketId,
            payload: stepCompletedPayload(stepRunId, terminalResult.output, terminalResult.usage),
          });
        } else if (terminalResult._tag === "failed") {
          yield* commit({
            type: "StepFailed",
            ticketId: recovered.stepStarted.ticketId,
            payload: stepFailedPayload(
              stepRunId,
              terminalResult.error,
              terminalResult.usage,
              terminalResult.retryable === false ? false : undefined,
            ),
          });
        } else {
          yield* commit({
            type: "StepBlocked",
            ticketId: recovered.stepStarted.ticketId,
            payload: { stepRunId, reason: terminalResult.reason },
          });
        }
      }

      // Never continue a pipeline the ticket has already left: a manual move
      // or re-route invalidated this lane entry token, so running more steps
      // or routing from here would act on stale state. The terminal step
      // event above is still recorded; the pipeline run closes superseded.
      if ((yield* currentToken(recovered.stepStarted.ticketId)) !== laneEntryToken) {
        yield* commit({
          type: "PipelineCompleted",
          ticketId: recovered.stepStarted.ticketId,
          payload: { pipelineRunId, result: "superseded" },
        });
        return;
      }

      let finalResult: StepResult =
        terminalResult._tag === "completed"
          ? "completed"
          : terminalResult._tag === "blocked"
            ? "blocked"
            : "failed";

      // Resume the retry loop across restarts: a failed attempt recovered
      // mid-policy keeps consuming its remaining attempts (with escalation),
      // unless the failure was a user rejection/cancellation.
      if (
        finalResult === "failed" &&
        (terminalResult._tag !== "failed" || terminalResult.retryable !== false) &&
        recoveredStep !== undefined &&
        options?.allowRetry !== false
      ) {
        const maxAttempts = retryAttemptsForStep(recoveredStep);
        let attempt = recovered.stepStarted.payload.attempt ?? 1;
        let outcome: StepRunOutcome = { result: "failed", noRetry: false };
        while (outcome.result === "failed" && !outcome.noRetry && attempt < maxAttempts) {
          attempt += 1;
          outcome = yield* runStep(
            recovered.stepStarted.ticketId,
            boardId,
            recovered.pipelineStarted.payload.pipelineRunId,
            stepForAttempt(recoveredStep, attempt),
            laneEntryToken,
            lane.key,
            steps.map((s) => s.key),
            attempt,
          );
        }
        if (attempt > (recovered.stepStarted.payload.attempt ?? 1)) {
          finalResult = outcome.result;
        }
      }

      const recoveredResult: PipelineResult = pipelineResultForStep(finalResult);
      const initialRouteDecision = recoveredStep
        ? stepRouteDecision(recoveredStep, recoveredResult)
        : null;

      yield* completePipelineFrom(
        recovered.stepStarted.ticketId,
        boardId,
        lane,
        laneEntryToken,
        recovered.pipelineStarted.payload.pipelineRunId,
        steps,
        initialRouteDecision === null && finalResult === "completed"
          ? currentStepIndex + 1
          : steps.length,
        recoveredResult,
        initialRouteDecision ?? undefined,
      );
    });

  const completeRecoveredStep: WorkflowEngineShape["completeRecoveredStep"] = (
    stepRunId,
    result,
    captureTurn,
  ) =>
    Effect.gen(function* () {
      const claimed = yield* SynchronizedRef.modify(recoveredStepClaims, (current) => {
        const key = stepRunId as string;
        if (current.has(key)) {
          return [false, current] as const;
        }
        const next = new Set(current);
        next.add(key);
        return [true, next] as const;
      });
      if (!claimed) {
        return;
      }
      yield* completeRecoveredStepUnlocked(stepRunId, result, captureTurn).pipe(
        // Release the claim on failure so a later monitor/sweep can finish
        // what this continuation could not.
        Effect.onError(() =>
          SynchronizedRef.update(recoveredStepClaims, (current) => {
            const next = new Set(current);
            next.delete(stepRunId as string);
            return next;
          }),
        ),
      );
    });

  const continueRecoveredApproval = (pending: PendingWait, approved: boolean) =>
    Effect.gen(function* () {
      const events = yield* readStoredEventsForStep(pending.payload.stepRunId);
      if (events === null || !pendingWaitInEvents(events, pending.payload.stepRunId)) {
        return;
      }

      const recovered = recoveredStepContext(events, pending.payload.stepRunId);
      if (!recovered) {
        return;
      }

      yield* commit({
        type: "StepUserResolved",
        ticketId: pending.ticketId,
        payload: { stepRunId: pending.payload.stepRunId },
      });
      if (!approved) {
        yield* completeRecoveredStepUnlocked(
          pending.payload.stepRunId,
          {
            _tag: "failed",
            error: "rejected",
          },
          undefined,
          { allowRetry: false },
        );
        return;
      }

      const terminalResult =
        pending.payload.providerThreadId === undefined
          ? ({ _tag: "completed" } satisfies RecoveredStepResult)
          : yield* awaitProviderTerminalForStep(
              pending.payload.stepRunId,
              pending.payload.providerThreadId,
            );
      yield* completeRecoveredStepUnlocked(pending.payload.stepRunId, terminalResult, undefined);
    });

  const cancelStep: WorkflowEngineShape["cancelStep"] = (stepRunId) =>
    scriptCancels.cancel(stepRunId);

  const cancelBoardPipelines: WorkflowEngineShape["cancelBoardPipelines"] = (boardId) =>
    Effect.gen(function* () {
      const tickets = yield* read.listTickets(boardId);
      yield* Effect.forEach(
        tickets,
        (ticket) => interruptRunningPipeline(ticket.ticketId as TicketId),
        { discard: true },
      );
      yield* cancelActiveProviderTurns(boardId);
    });

  const cancelTicketPipelines: WorkflowEngineShape["cancelTicketPipelines"] = (ticketId) =>
    Effect.gen(function* () {
      yield* interruptRunningPipeline(ticketId);
      yield* cancelActiveProviderTurnsForTicket(ticketId);
    });

  const resolveApproval: WorkflowEngineShape["resolveApproval"] = (stepRunId, approved) =>
    Effect.gen(function* () {
      const resolve = Effect.gen(function* () {
        const pending = yield* pendingWaitFor(stepRunId);
        const { providerResponses } = yield* getOptionalServices;
        if (pending?.payload.providerResponseKind === "user-input") {
          return yield* new WorkflowEventStoreError({
            message: "provider user-input waits must be answered with answerTicketStep",
          });
        }
        if (
          pending?.payload.providerThreadId &&
          pending.payload.providerRequestId &&
          pending.payload.providerResponseKind &&
          Option.isSome(providerResponses)
        ) {
          yield* providerResponses.value.respond({
            threadId: pending.payload.providerThreadId,
            requestId: pending.payload.providerRequestId,
            responseKind: pending.payload.providerResponseKind,
            approved,
          });
        }

        const resumedLiveWaiter = yield* approvals.resolve(stepRunId, approved);
        if (!resumedLiveWaiter && pending) {
          yield* continueRecoveredApproval(pending, approved);
        }
      });
      // Resolution serializes through the inner recovery path's own locking
      // (continueRecoveredApproval -> commit/completeRecoveredStepUnlocked);
      // no board-level lock is taken here, so the prior boardId lookup was a
      // dead query that only ever branched into identical effects.
      yield* resolve;
    });

  return {
    createTicket,
    editTicket,
    moveTicket,
    createTicketAndEnterUnlocked,
    closeTicketFromSourceUnlocked,
    reopenTicketFromSourceUnlocked,
    cancellableProviderTurnsForTicket,
    supersedeProviderWorkForTicket,
    terminalAgentSessionThreadsForTicket,
    stopAgentSessionsForTicket,
    editTicketFieldsUnlocked,
    withBoardAdmissionLock,
    runLane,
    ingestExternalEvent,
    resolveApproval,
    answerTicketStep,
    postTicketMessage,
    editTicketMessage,
    cancelStep,
    cancelBoardPipelines,
    cancelTicketPipelines,
    recoverBoardWip,
    completeRecoveredStep,
  } satisfies WorkflowEngineShape;
});

export const WorkflowEngineLayer = Layer.effect(WorkflowEngine, make);
