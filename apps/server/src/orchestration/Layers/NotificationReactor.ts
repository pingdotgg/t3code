/**
 * NotificationReactor — server-side notification edge detection.
 *
 * The reactor is the *only* place that decides a notification-worthy edge
 * happened. Transports subscribe to what it recorded; they never re-derive it.
 * Phase derivation is shared (`@t3tools/shared/agentAwareness`) so the sidebar and
 * the notifications can never disagree about what a thread is doing.
 *
 * Two things make this reliable rather than best-effort:
 *
 * - **Every candidate edge is recorded**, fired or suppressed, with the verdict
 *   and the guard that produced it. "Why did nothing happen?" is a row, not an
 *   absence. Detection never consults a user setting — enabled/focused are
 *   transport outcomes reported back onto the row.
 * - **A durable cursor** (`projection_state`, projector `notifications.outbox`)
 *   plus `identity_key` as the outbox primary key. A restart resumes where it
 *   stopped, a re-published sequence is skipped, and a replay from 0 rewrites
 *   nothing.
 */
import {
  NOTIFICATION_IDENTITY_PREFIX,
  type NotificationDetectionVerdict,
  type NotificationKind,
  type NotificationThreadPhase,
  type OrchestrationEvent,
  type OrchestrationLatestTurnState,
  type OrchestrationThreadShell,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import {
  detailForPhase,
  headlineForNotificationKind,
  isUserInitiatedTurn,
  resolveThreadAwarenessPhase,
  threadHasPendingApproval,
} from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import { type Decision, withDecisionSpan } from "../../observability/DecisionSpan.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import {
  NotificationOutboxRepository,
  type NotificationOutboxRecord,
  notificationDecidedEdgeFromRecord,
} from "../../persistence/Services/NotificationOutbox.ts";
import {
  ProjectionStateRepository,
  type ProjectionState,
} from "../../persistence/Services/ProjectionState.ts";
import { NotificationEdgeBus } from "../Services/NotificationEdgeBus.ts";
import {
  NotificationReactor,
  type NotificationReactorShape,
} from "../Services/NotificationReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

/**
 * Cursor key in `projection_state`. Deliberately a sibling of the
 * `projection.*` projector names rather than one of them: the reactor is not
 * part of `ProjectionPipeline` and must stay independently drainable.
 */
export const NOTIFICATION_OUTBOX_PROJECTOR_NAME = "notifications.outbox";

/** Domain events that can move the tracker or form a candidate edge. */
const OBSERVED_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.session-set",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "thread.proposed-plan-upserted",
  "thread.reverted",
]);

type ObservedEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.turn-start-requested"
      | "thread.session-set"
      | "thread.turn-diff-completed"
      | "thread.activity-appended"
      | "thread.proposed-plan-upserted"
      | "thread.reverted";
  }
>;

/**
 * What the reactor believes about a thread as of the last event it applied.
 *
 * This exists for exactly one reason: an *edge* needs two states, and the
 * second one is the only one an event carries. Rebuilt from the event stream on
 * every replay, so it is not state that can drift — a fresh replay from the
 * same cursor produces the same tracker.
 */
interface ThreadTracker {
  readonly phase: NotificationThreadPhase | null;
  readonly latestTurnId: TurnId | null;
  readonly latestTurnState: OrchestrationLatestTurnState | null;
  /**
   * The turn we believe is in flight. Survives the event where the session drops
   * `activeTurnId` before `latestTurn` catches up — see `preserveSettlingTurn`.
   */
  readonly runningTurnId: TurnId | null;
  /**
   * Whether `runningTurnId` traces back to a human prompt. `null` means we never
   * observed the turn as `latestTurn` while it ran and so cannot tell.
   */
  readonly runningTurnUserInitiated: boolean | null;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  /**
   * The terminal edge we already recorded, if any. Carries the kind as well as
   * the turn: a `turn-failed` after a fired `turn-completed` is not a duplicate,
   * it is the truer reading of the same turn and must be allowed through.
   */
  readonly notifiedTerminal: NotifiedTerminal | null;
}

type TerminalKind = "turn-completed" | "turn-failed";

interface NotifiedTerminal {
  readonly turnId: TurnId;
  readonly kind: TerminalKind;
}

interface TerminalCandidate {
  readonly kind: TerminalKind;
  readonly turnId: TurnId;
  readonly requestId: null;
}

interface AttentionCandidate {
  readonly kind: "approval-required" | "user-input-required";
  readonly turnId: TurnId | null;
  readonly requestId: string;
}

type Candidate = TerminalCandidate | AttentionCandidate;

/**
 * Span verdict enum, deliberately two-valued.
 *
 * `docs/agents/debugging.md`'s "why did nothing happen?" recipe filters on
 * `decision.verdict | IN("skip","suppress")`, so the specific detection verdict
 * rides along as `notifications.detection_verdict` (mirroring the outbox column)
 * instead of replacing `suppress`.
 */
type NotificationEdgeVerdict = "fire" | "suppress";

interface NotificationEdgeDecision extends Decision<NotificationEdgeVerdict> {
  readonly detectionVerdict: NotificationDetectionVerdict;
  readonly decidingGuard: string;
  /** Absent when the pre-existing row already *is* the record of this edge. */
  readonly row?: NotificationOutboxRecord;
  /**
   * Identity key of a recorded terminal row this edge takes the turn's slot
   * from. Only ever set for `failed` superseding `completed` (SPEC §2).
   */
  readonly supersedesIdentityKey?: string;
}

/**
 * Stable identity for an edge, and the whole reason a replay is idempotent.
 *
 * `updatedAt` is **banned** as an identity input (SPEC §2). It is the last
 * domain-event timestamp, not a write clock: two distinct rising edges can share
 * one value and collapse into one notification, while a flapping approval can be
 * re-announced under a fresh one. Terminal edges key on the turn that ended;
 * attention edges key on the request id that was raised.
 *
 * A checkpoint revert cannot resurrect a turnId here. Revert emits
 * `thread.checkpoint-revert-requested` / `thread.reverted` carrying only
 * `{ threadId, turnCount }`; it deletes forward turn rows and regresses
 * `latestTurn` to an *already-terminal older* turn. That is why terminal
 * detection below keys on the completion event and never on "latestTurn changed
 * and is terminal" — otherwise `thread.reverted` would read as a fresh
 * completion for a turnId already notified. A rerun after a revert mints a fresh
 * TurnId, so it is correctly a new notification.
 */
export function notificationIdentityKey(input: {
  readonly threadId: ThreadId;
  readonly kind: NotificationKind;
  readonly discriminator: string;
}): string {
  return `${NOTIFICATION_IDENTITY_PREFIX}:${input.threadId}:${input.kind}:${input.discriminator}`;
}

function isTerminalPhase(phase: NotificationThreadPhase | null): boolean {
  return phase === "completed" || phase === "failed";
}

function observedRunningTurnId(shell: OrchestrationThreadShell): TurnId | null {
  return (
    shell.session?.activeTurnId ??
    (shell.latestTurn?.state === "running" ? shell.latestTurn.turnId : null)
  );
}

function observeThread(shell: OrchestrationThreadShell): ThreadTracker {
  const runningTurnId = observedRunningTurnId(shell);
  const latestTurnId = shell.latestTurn?.turnId ?? null;
  return {
    phase: resolveThreadAwarenessPhase(shell),
    latestTurnId,
    latestTurnState: shell.latestTurn?.state ?? null,
    runningTurnId,
    runningTurnUserInitiated:
      runningTurnId !== null && runningTurnId === latestTurnId ? isUserInitiatedTurn(shell) : null,
    // Read from the raw booleans, never the phase: phase derivation is
    // priority-ordered, so a thread with both a pending approval and pending
    // input only ever reports `waiting_for_approval`.
    hasPendingApproval: threadHasPendingApproval(shell),
    hasPendingUserInput: shell.hasPendingUserInput,
    notifiedTerminal: null,
  };
}

/**
 * Carry "we saw turn T running" across the event where the session has already
 * cleared `activeTurnId` but `latestTurn` still points at the *previous* turn.
 * Without this, a fast turn looks like it never ran and its completion is
 * silently dropped.
 *
 * A carried turn is released once `latestTurn` catches up to it (whatever state
 * it lands in), or once the thread reaches a terminal phase with no materialized
 * `latestTurn` at all — the session-set projection clears `latest_turn_id` when a
 * session settles, and without that release the carry would never expire.
 *
 * `canRelease` is what keeps that release honest when the reactor is behind. The
 * projection read is always *head* state, never state as of this event: an event
 * that says nothing about turns or sessions (an appended activity, say) can still
 * observe a teardown that a later, not-yet-processed event caused. Releasing the
 * carry on such an event throws away the only evidence that the turn ran, and the
 * completion that follows is then silently dropped as `baseline`. So only events
 * that genuinely speak about the session or the turn set may release it.
 *
 * Belt and braces: on an ordered post-commit event stream the interleaving this
 * defends against is much less likely than over the client's snapshot polling,
 * but the failure mode (a silently dropped completion) is invisible, so the guard
 * is kept rather than trusted away.
 */
function preserveSettlingTurn(
  previous: ThreadTracker,
  next: ThreadTracker,
  canRelease: boolean,
): ThreadTracker {
  if (next.runningTurnId !== null || previous.runningTurnId === null) {
    return next;
  }
  const caughtUp =
    next.latestTurnId === previous.runningTurnId && next.latestTurnState !== "running";
  const clearedByTeardown = next.latestTurnId === null && isTerminalPhase(next.phase);
  if (canRelease && (caughtUp || clearedByTeardown)) {
    return next;
  }
  return {
    ...next,
    runningTurnId: previous.runningTurnId,
    runningTurnUserInitiated: previous.runningTurnUserInitiated,
  };
}

/**
 * Events whose payload is about the session or the turn set, and which may
 * therefore retire a carried running turn. Everything else only ever adds.
 */
function canReleaseSettlingTurn(event: ObservedEvent): boolean {
  return event.type === "thread.session-set" || event.type === "thread.reverted";
}

function carryForward(
  previous: ThreadTracker,
  observed: ThreadTracker,
  canRelease: boolean,
): ThreadTracker {
  const next = preserveSettlingTurn(previous, observed, canRelease);
  const sameTurn = next.runningTurnId !== null && next.runningTurnId === previous.runningTurnId;
  return {
    ...next,
    // Keep the earliest reading: a user message arriving after the turn started
    // must not retroactively promote a background turn into a notifiable one.
    runningTurnUserInitiated:
      sameTurn && previous.runningTurnUserInitiated !== null
        ? previous.runningTurnUserInitiated
        : next.runningTurnUserInitiated,
    notifiedTerminal: previous.notifiedTerminal,
  };
}

/**
 * Which turn a session-status change just settled, if any.
 *
 * Requires that the turn was observed running *before* this event. That single
 * condition also covers "do not notify for threads we only just started
 * watching".
 */
function settledTurnId(previous: ThreadTracker, next: ThreadTracker): TurnId | null {
  if (previous.runningTurnId === null || !isTerminalPhase(next.phase)) {
    return null;
  }
  if (next.latestTurnId === previous.runningTurnId) {
    return next.latestTurnId;
  }
  // Turns that never produce a checkpoint leave no materialized `latestTurn`;
  // the session settling is the only surviving completion signal.
  return next.latestTurnId === null ? previous.runningTurnId : null;
}

/** True once the turn has been seen running at or before the previous event. */
function observedRunning(previous: ThreadTracker, turnId: TurnId): boolean {
  return (
    previous.runningTurnId === turnId ||
    (previous.latestTurnId === turnId && previous.latestTurnState === "running")
  );
}

function activityRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
}

/**
 * Candidate edges this event could have produced.
 *
 * Event-driven, not diff-driven: the completion event *is* the terminal edge.
 * Diffing "latestTurn changed and is terminal" would misread `thread.reverted`
 * as a completion (see `notificationIdentityKey`).
 */
function formCandidates(input: {
  readonly event: ObservedEvent;
  readonly previous: ThreadTracker;
  readonly next: ThreadTracker;
}): ReadonlyArray<Candidate> {
  const { event, previous, next } = input;

  switch (event.type) {
    case "thread.turn-diff-completed": {
      // `failed` beats `completed`: the two terminal kinds are mutually
      // exclusive per turn and a failure is the more actionable of the two.
      const failed = next.phase === "failed" || event.payload.status === "error";
      return [
        {
          kind: failed ? "turn-failed" : "turn-completed",
          turnId: event.payload.turnId,
          requestId: null,
        },
      ];
    }
    case "thread.session-set": {
      const turnId = settledTurnId(previous, next);
      if (turnId === null) {
        return [];
      }
      return [
        {
          kind: next.phase === "failed" ? "turn-failed" : "turn-completed",
          turnId,
          requestId: null,
        },
      ];
    }
    case "thread.activity-appended": {
      const activity = event.payload.activity;
      const requestId: string =
        activityRequestId(activity.payload) ??
        event.metadata.requestId ??
        // No stable request id on this path (Claude's `user-input.requested` can
        // omit it), so the activity's own EventId is the identity.
        activity.id;

      if (activity.kind === "approval.requested" && next.hasPendingApproval) {
        return [{ kind: "approval-required", turnId: activity.turnId, requestId }];
      }
      if (activity.kind === "user-input.requested" && next.hasPendingUserInput) {
        return [{ kind: "user-input-required", turnId: activity.turnId, requestId }];
      }
      // A request already resolved by the time we see it raised is not an edge:
      // the raw booleans guard the activity rather than the other way round.
      return [];
    }
    case "thread.proposed-plan-upserted": {
      // A plan waiting to be implemented is an approval the user has to give, so
      // it goes out as `approval-required` — keyed on the plan's own stable id,
      // since a plan carries no request id.
      //
      // Deliberately *not* gated on a rising `hasPendingApproval`: plan-mode
      // revision proposes plan 2 while plan 1 is still un-implemented, so the
      // boolean never falls and the second plan would never be announced. The
      // plan id is the identity, so a re-upsert of the same plan is deduped by
      // identity instead — which is also what makes the dedup survive a replay.
      const plan = event.payload.proposedPlan;
      // An already-implemented plan is nothing to approve. Read from the event's
      // own payload rather than the thread-level boolean: the projection's
      // actionable flag falls back to the newest plan overall, which is not
      // necessarily this one.
      if (plan.implementedAt !== null || !next.hasPendingApproval) {
        return [];
      }
      return [
        {
          kind: "approval-required",
          turnId: plan.turnId,
          requestId: plan.id,
        },
      ];
    }
    default:
      // `thread.message-sent`, `thread.turn-start-requested` and
      // `thread.reverted` only move the tracker. Revert in particular must form
      // no candidate: it regresses `latestTurn` to an already-terminal turn.
      return [];
  }
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Mirror the outbox's `detection_verdict` / `deciding_guard` onto the span.
 *
 * `decision.verdict` stays two-valued so `docs/agents/debugging.md`'s
 * "why did nothing happen?" recipe (`decision.verdict | IN("skip","suppress")`)
 * keeps working across subsystems; the specific verdict rides alongside so a
 * trace and a row answer the same question the same way.
 */
function annotateDetectionVerdict<E, R>(
  decide: Effect.Effect<NotificationEdgeDecision, E, R>,
): Effect.Effect<NotificationEdgeDecision, E, R> {
  return Effect.map(decide, (decision) => ({
    ...decision,
    attributes: {
      ...decision.attributes,
      "notifications.detection_verdict": decision.detectionVerdict,
      "notifications.deciding_guard": decision.decidingGuard,
    },
  }));
}

export const makeNotificationReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const outbox = yield* NotificationOutboxRepository;
  const projectionState = yield* ProjectionStateRepository;
  const edgeBus = yield* NotificationEdgeBus;

  // Rebuilt from the event stream, so it needs no persistence of its own: the
  // durable cursor plus a replay reproduces it exactly.
  const trackers = new Map<ThreadId, ThreadTracker>();
  let cursor = 0;
  /**
   * Highest sequence belonging to the boot catch-up range. Edges decided from it
   * are recorded but not published: they happened before this process (and before
   * any transport now attached) existed.
   */
  let replayThroughSequence = 0;

  // The live feed is buffered here while the boot catch-up runs, so an event
  // published mid-catch-up is not dropped. `buffered` mirrors the hop into the
  // worker so `drain` can account for it — without it, `drain` would report
  // "everything decided" while an event still sat in this queue.
  const liveBuffer = yield* Queue.unbounded<ObservedEvent>();
  const buffered = yield* TxRef.make(0);

  const evaluateTerminalEdge = Effect.fn("evaluateTerminalEdge")(function* (input: {
    readonly candidate: TerminalCandidate;
    readonly row: NotificationOutboxRecord;
    readonly previous: ThreadTracker;
    readonly next: ThreadTracker;
  }): Effect.fn.Return<NotificationEdgeDecision, ProjectionRepositoryError> {
    const { candidate, row, previous, next } = input;

    // In-memory fast path for the common double edge (a diff completion and its
    // session teardown): the same kind for the same turn we just announced.
    if (
      previous.notifiedTerminal !== null &&
      previous.notifiedTerminal.turnId === candidate.turnId &&
      previous.notifiedTerminal.kind === candidate.kind
    ) {
      return {
        verdict: "suppress",
        reason: "this reactor already recorded this terminal edge for this turn",
        detectionVerdict: "already-notified",
        decidingGuard: "notified-terminal-turn",
      };
    }

    // The two terminal kinds share one `(threadId, turnId)` slot, so a recorded
    // row can veto this candidate — but only in the directions SPEC §2 allows.
    const existing = yield* outbox.findTerminalByThreadTurn({
      threadId: row.threadId,
      turnId: candidate.turnId,
    });
    let supersedes: string | undefined;
    if (Option.isSome(existing)) {
      const recorded = existing.value;
      if (recorded.kind === candidate.kind) {
        return {
          verdict: "suppress",
          reason: `this turn already has a ${recorded.kind} row recorded as ${recorded.detectionVerdict}`,
          detectionVerdict:
            recorded.detectionVerdict === "detected" ? "already-notified" : "duplicate-identity",
          decidingGuard: "terminal-turn-unique",
        };
      }
      if (candidate.kind === "turn-completed") {
        // `failed` won this turn already; a later completion is the weaker fact.
        return {
          verdict: "suppress",
          reason: "this turn was already recorded as turn-failed, and failed wins over completed",
          detectionVerdict: "already-notified",
          decidingGuard: "failed-wins-over-completed",
        };
      }
      // A failure outranks a recorded completion — including a completion that
      // was only recorded for the audit (`baseline`, `not-user-initiated`), which
      // must never be able to mute a real failure. The recorded row gives up the
      // turn's slot; see `deleteByIdentityKey`.
      supersedes = recorded.identityKey;
    }

    if (!observedRunning(previous, candidate.turnId)) {
      return {
        verdict: "suppress",
        reason: "the turn was never observed running, so its completion is not a proven edge",
        detectionVerdict: "baseline",
        decidingGuard: "observed-running",
        row,
      };
    }

    // `null` means we never got a look at the turn while it ran, so we cannot
    // classify it — notify rather than drop. A genuine background turn always
    // carries a `latestTurn` to inspect.
    const userInitiated = previous.runningTurnUserInitiated ?? next.runningTurnUserInitiated;
    // Failures always surface: a background turn that broke is still the user's
    // problem. Only silent success is filtered.
    if (candidate.kind === "turn-completed" && userInitiated === false) {
      return {
        verdict: "suppress",
        reason: "no user message at or after the turn's requestedAt, so no human asked for it",
        detectionVerdict: "not-user-initiated",
        decidingGuard: "user-initiated-turn",
        row,
      };
    }

    return {
      verdict: "fire",
      reason: `a turn observed running settled as ${candidate.kind}`,
      detectionVerdict: "detected",
      decidingGuard: "terminal-edge",
      row,
      ...(supersedes === undefined ? {} : { supersedesIdentityKey: supersedes }),
    };
  });

  const evaluateAttentionEdge = Effect.fn("evaluateAttentionEdge")(function* (input: {
    readonly row: NotificationOutboxRecord;
  }): Effect.fn.Return<NotificationEdgeDecision, ProjectionRepositoryError> {
    const existing = yield* outbox.getByIdentityKey({ identityKey: input.row.identityKey });
    if (Option.isSome(existing)) {
      return {
        verdict: "suppress",
        reason: "this request id was already recorded, so the raised hand is not new",
        detectionVerdict: "duplicate-identity",
        decidingGuard: "identity-key-unique",
      };
    }
    return {
      verdict: "fire",
      reason: "a new request id is waiting on the user",
      detectionVerdict: "detected",
      decidingGuard: "attention-edge",
      row: input.row,
    };
  });

  const recordCandidate = Effect.fn("recordCandidate")(function* (input: {
    readonly event: ObservedEvent;
    readonly candidate: Candidate;
    readonly shell: OrchestrationThreadShell;
    readonly projectTitle: string;
    readonly previous: ThreadTracker;
    readonly next: ThreadTracker;
    readonly detectedAt: string;
    /**
     * Whether a detected edge may reach the live bus. False while replaying the
     * catch-up range on boot: those edges are recorded (audit-complete) but never
     * pushed, or a transport that connected without a resume cursor would get a
     * burst of edges decided from events that predate its launch (SPEC §5).
     */
    readonly publish: boolean;
  }) {
    const { event, candidate, shell, previous, next } = input;
    const terminal = candidate.requestId === null;
    const identityKey = notificationIdentityKey({
      threadId: shell.id,
      kind: candidate.kind,
      discriminator: terminal ? candidate.turnId : candidate.requestId,
    });
    const phaseForDetail: NotificationThreadPhase | null = terminal
      ? candidate.kind === "turn-failed"
        ? "failed"
        : "completed"
      : null;

    const row: NotificationOutboxRecord = {
      identityKey,
      kind: candidate.kind,
      threadId: shell.id,
      projectId: shell.projectId,
      turnId: candidate.turnId,
      requestId: candidate.requestId,
      projectTitle: input.projectTitle,
      threadTitle: shell.title,
      // Copy keys on the kind, not the phase: an input edge on a thread that
      // also has a pending approval would otherwise read "Approval needed".
      headline: headlineForNotificationKind(candidate.kind),
      detail: phaseForDetail === null ? null : (detailForPhase(phaseForDetail, shell) ?? null),
      triggeringEventId: event.eventId,
      triggeringSequence: event.sequence,
      previousPhase: previous.phase,
      nextPhase: next.phase,
      detectionVerdict: "detected",
      decidingGuard: "pending",
      transportOutcome: "no-transport-connected",
      transportName: null,
      completedAt: null,
      detectedAt: input.detectedAt,
    };

    const decision = yield* withDecisionSpan(
      "notifications.decide.edge",
      {
        candidate: `notifications.${candidate.kind}`,
        keys: {
          correlationId: event.correlationId,
          commandId: event.commandId,
          threadId: shell.id,
          turnId: candidate.turnId,
          approvalRequestId: candidate.requestId,
        },
        attributes: {
          "notifications.identity_key": identityKey,
          "notifications.triggering_event_type": event.type,
          "notifications.triggering_sequence": event.sequence,
        },
      },
      annotateDetectionVerdict(
        terminal
          ? evaluateTerminalEdge({ candidate, row, previous, next })
          : evaluateAttentionEdge({ row }),
      ),
    );

    if (decision.row !== undefined) {
      const recorded: NotificationOutboxRecord = {
        ...decision.row,
        detectionVerdict: decision.detectionVerdict,
        decidingGuard: decision.decidingGuard,
      };
      if (decision.verdict === "fire" && decision.supersedesIdentityKey !== undefined) {
        // Only a firing edge takes the slot: a failure suppressed as `baseline`
        // has nothing truer to say than the completion already on record, so the
        // insert below is left to no-op against the unique index.
        yield* outbox.deleteByIdentityKey({ identityKey: decision.supersedesIdentityKey });
      }
      yield* outbox.insertIfAbsent(recorded);
      if (recorded.detectionVerdict === "detected" && input.publish) {
        // Hand the edge to whatever transport is listening *now*. Nothing
        // listening means nothing published — the row stays
        // `no-transport-connected`, which is the honest record.
        yield* edgeBus.publish(notificationDecidedEdgeFromRecord(recorded));
      }
    }

    return decision.verdict === "fire" && terminal
      ? ({ turnId: candidate.turnId, kind: candidate.kind } satisfies NotifiedTerminal)
      : null;
  });

  const processEvent = Effect.fn("processEvent")(function* (event: ObservedEvent) {
    // The failure-reconciliation path can re-publish an already-seen sequence,
    // so this is `<=`, not a plain inequality.
    if (event.sequence <= cursor) {
      return;
    }

    const threadId = event.payload.threadId;
    const shellOption = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(shellOption)) {
      // Archived or deleted threads are not readable as shells, so there is no
      // presentation text to record a candidate with. Drop the tracker and move
      // on; the absence of a row is the correct record here.
      trackers.delete(threadId);
      cursor = event.sequence;
      yield* projectionState.upsert({
        projector: NOTIFICATION_OUTBOX_PROJECTOR_NAME,
        lastAppliedSequence: event.sequence,
        updatedAt: event.occurredAt,
      });
      return;
    }
    // The projection read is head state, not state as of this event. Where the
    // event carries the very thing being read, prefer the event: a session-set
    // event *is* the session it announces, so a reactor running behind a newer
    // session write still decides against the session this event set.
    const shell =
      event.type === "thread.session-set"
        ? { ...shellOption.value, session: event.payload.session }
        : shellOption.value;

    const observed = observeThread(shell);
    const previous = trackers.get(threadId);
    if (previous === undefined) {
      // First observation of this thread: nothing to form an edge against.
      trackers.set(threadId, observed);
    } else {
      const next = carryForward(previous, observed, canReleaseSettlingTurn(event));
      const candidates = formCandidates({ event, previous, next });

      let notifiedTerminal = next.notifiedTerminal;
      if (candidates.length > 0) {
        const projectOption = yield* projectionSnapshotQuery.getProjectShellById(shell.projectId);
        if (Option.isNone(projectOption)) {
          // Never invent a title. A snapshot that lists a thread without its
          // project is mid-write; the next event carries both.
          yield* Effect.logDebug("notification candidate skipped: project shell not visible", {
            threadId,
            projectId: shell.projectId,
          });
        } else {
          const detectedAt = yield* nowIso;
          for (const candidate of candidates) {
            const fired = yield* recordCandidate({
              event,
              candidate,
              shell,
              projectTitle: projectOption.value.title,
              previous,
              next,
              detectedAt,
              publish: event.sequence > replayThroughSequence,
            });
            notifiedTerminal = fired ?? notifiedTerminal;
          }
        }
      }

      trackers.set(threadId, { ...next, notifiedTerminal });
    }

    cursor = event.sequence;
    yield* projectionState.upsert({
      projector: NOTIFICATION_OUTBOX_PROJECTOR_NAME,
      lastAppliedSequence: event.sequence,
      updatedAt: event.occurredAt,
    });
  });

  const processEventSafely = (event: ObservedEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("notification reactor failed to process event", {
          eventType: event.type,
          sequence: event.sequence,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  /**
   * Prime the trackers from the shells as they stand *now*.
   *
   * An edge needs a previous state, and after a restart the previous state is
   * whatever the projection already holds — without this a turn that was running
   * when the server went down completes into an empty tracker and its completion
   * is silently dropped. Priming is a level read, so it can never produce a
   * candidate of its own, and a turn already recorded is still caught by the
   * outbox's terminal uniqueness.
   *
   * What a tracker already learned from the event stream outranks the level read
   * on exactly one field: a terminal edge this reactor announced stays announced.
   */
  const primeTrackers = Effect.fnUntraced(function* () {
    const shells = yield* projectionSnapshotQuery
      .getShellSnapshot()
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (shells === null) {
      return;
    }
    for (const shell of shells.threads) {
      const observed = observeThread(shell);
      const known = trackers.get(shell.id);
      trackers.set(shell.id, {
        ...observed,
        notifiedTerminal: known?.notifiedTerminal ?? null,
      });
    }
  });

  const start: NotificationReactorShape["start"] = Effect.fn("start")(function* () {
    // Buffer the live stream before reading any historical state, or an event
    // published during catch-up is dropped on the floor.
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        OBSERVED_EVENT_TYPES.has(event.type)
          ? TxRef.update(buffered, (pending) => pending + 1).pipe(
              Effect.andThen(Queue.offer(liveBuffer, event as ObservedEvent)),
            )
          : Effect.void,
      ),
    );

    const persisted = yield* projectionState
      .getByProjector({ projector: NOTIFICATION_OUTBOX_PROJECTOR_NAME })
      .pipe(Effect.catchCause(() => Effect.succeed(Option.none<ProjectionState>())));

    if (Option.isNone(persisted)) {
      // First boot: everything already in the store is history, not news. The
      // cursor starts at the head so a fresh install never replays a backlog of
      // long-finished turns into someone's notification centre.
      cursor = yield* orchestrationEngine.latestSequence;
      yield* projectionState
        .upsert({
          projector: NOTIFICATION_OUTBOX_PROJECTOR_NAME,
          lastAppliedSequence: cursor,
          updatedAt: yield* nowIso,
        })
        .pipe(Effect.catchCause(() => Effect.void));
      yield* primeTrackers();
    } else {
      cursor = persisted.value.lastAppliedSequence;
      // Everything committed while we were down is replayed, but not published:
      // it predates every transport now attached (SPEC §5, no catch-up on
      // launch), and a transport that wants the gap asks for it with a cursor.
      replayThroughSequence = yield* orchestrationEngine.latestSequence;
      // Deliberately *not* primed first: priming is a head read, and head is
      // already past this range, so a primed tracker would decide every replayed
      // edge against a state from the future ("this turn was never running" for a
      // turn that ran and finished inside the range). Replaying with no tracker
      // means the range's first event per thread establishes the baseline, and
      // the head read lands afterwards for the live events that follow.
      yield* Stream.runForEach(
        orchestrationEngine.readEvents(cursor, Number.MAX_SAFE_INTEGER),
        (event) =>
          OBSERVED_EVENT_TYPES.has(event.type)
            ? worker.enqueue(event as ObservedEvent)
            : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("notification reactor catch-up failed", {
            cursor,
            cause: Cause.pretty(cause),
          }),
        ),
      );
      // The replay must be fully applied before the level read overwrites the
      // trackers it built, so this drain is load-bearing, not a convenience.
      yield* worker.drain;
      yield* primeTrackers();
    }

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(liveBuffer), (event) =>
        worker
          .enqueue(event)
          .pipe(Effect.andThen(TxRef.update(buffered, (pending) => pending - 1))),
      ),
    );
  });

  /**
   * Resolves once every observed event has been decided.
   *
   * `worker.drain` alone would miss an event still sitting in `liveBuffer`: the
   * worker's outstanding count only starts at `enqueue`. Waiting out the buffer
   * first is what makes "drained" mean the same thing to a test and to shutdown.
   */
  const drain = TxRef.get(buffered).pipe(
    Effect.tap((pending) => (pending > 0 ? Effect.txRetry : Effect.void)),
    Effect.tx,
    Effect.andThen(worker.drain),
  );

  return {
    start,
    drain,
  } satisfies NotificationReactorShape;
});

export const NotificationReactorLive = Layer.effect(NotificationReactor, makeNotificationReactor);
