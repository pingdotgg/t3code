import {
  type OrchestrationEvent,
  type ProjectId,
  type PullRequestMonitorFinding,
  type PullRequestMonitorSubmitFindingsInput,
  type ReviewResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionStateRepository } from "../persistence/Services/ProjectionState.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { repositoryFromPullRequestUrl } from "./canonicalKey.ts";
import { PullRequestMonitorService } from "./PullRequestMonitorService.ts";
import { createHash } from "node:crypto";

/** Cursor row name for the durable handoff position; see ProjectionStateRepository. */
export const REVIEW_HANDOFF_PROJECTOR = "pullRequestReviewHandoff";

/** Transient submit failures retry; a persistently failing event is skipped until restart. */
const SUBMIT_RETRY = Schedule.exponential("1 seconds").pipe(
  Schedule.both(Schedule.recurs(5)),
  Schedule.jittered,
);

/** Backlog replay retries before live handling pauses until restart (see startup below). */
const REPLAY_RETRY = SUBMIT_RETRY;

const SEVERITY_BY_PRIORITY = {
  critical: "blocker",
  high: "major",
  medium: "minor",
  low: "nit",
} as const;

/** Monitor finding fields are length-capped by contract; keep the longest valid value. */
const truncate = (value: string, max: number) =>
  value.length <= max ? value : value.slice(0, max - 1).trimEnd() + "…";

/**
 * Finding ids are positional (`finding-1`), so they reorder across re-reviews. Derive a
 * content-stable key over all stable finding content so re-submitting an unchanged finding
 * updates its durable item instead of forking it, and distinct findings never collide.
 */
export const reviewFindingKey = (input: {
  readonly diffHash: string;
  readonly path: string;
  readonly side: "new" | "old";
  readonly startLine: number;
  readonly endLine: number;
  readonly title: string;
  readonly body: string;
  readonly priority: string;
}): string => createHash("sha1").update(JSON.stringify(input)).digest("hex").slice(0, 16);

export interface ParsedPullRequestReview {
  readonly reviewThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly diffHash: string;
  readonly summary: string;
  readonly findings: readonly {
    readonly id: string;
    readonly priority: "critical" | "high" | "medium" | "low";
    readonly title: string;
    readonly body: string;
    readonly location: {
      readonly path: string;
      readonly side: "new" | "old";
      readonly startLine: number;
      readonly endLine: number;
    };
  }[];
}

/**
 * Convert a persisted PR review result into a submitFindings handoff. Non-PR scopes,
 * invalid output, zero-finding reviews, and unresolvable projects do not qualify.
 */
export function handoffFromReviewResult(input: {
  readonly reviewThreadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly result: ReviewResult;
}): ParsedPullRequestReview | null {
  if (input.result.status !== "parsed" || input.result.findings.length === 0) return null;
  const scope = input.result.snapshot.scope;
  if (scope.kind !== "pull-request") return null;
  if (input.projectId === null) return null;
  if (scope.headSha === undefined) return null;
  const repository = repositoryFromPullRequestUrl(scope.url);
  if (repository === null) return null;
  return {
    reviewThreadId: input.reviewThreadId,
    projectId: input.projectId,
    repository,
    number: scope.number,
    headSha: scope.headSha,
    diffHash: input.result.snapshot.diffHash,
    summary: input.result.summary,
    findings: input.result.findings.map((finding) => ({
      id: finding.id,
      priority: finding.priority,
      title: finding.title,
      body: finding.body,
      location: {
        path: finding.location.path,
        side: finding.location.side,
        startLine: finding.location.startLine,
        endLine: finding.location.endLine,
      },
    })),
  };
}

export function handoffToSubmitInput(
  review: ParsedPullRequestReview,
): PullRequestMonitorSubmitFindingsInput {
  return {
    reference: {
      projectId: review.projectId,
      repository: review.repository,
      number: review.number,
    },
    reviewThreadId: review.reviewThreadId,
    reviewedHeadSha: review.headSha,
    summary: truncate(review.summary, 2_000),
    findings: review.findings.map((finding): PullRequestMonitorFinding => {
      const key = reviewFindingKey({
        diffHash: review.diffHash,
        path: finding.location.path,
        side: finding.location.side,
        startLine: finding.location.startLine,
        endLine: finding.location.endLine,
        title: finding.title,
        body: finding.body,
        priority: finding.priority,
      });
      return {
        key: `review-${key}`,
        title: truncate(finding.title, 200),
        detail: finding.body,
        provenance: {
          findingId: finding.id,
          reviewedHeadSha: review.headSha,
          diffHash: review.diffHash,
          ...finding.location,
        },
        severity: SEVERITY_BY_PRIORITY[finding.priority],
        path: truncate(finding.location.path, 500),
        line: finding.location.startLine,
      };
    }),
  };
}

const isHandoffEvent = (
  event: OrchestrationEvent,
): event is OrchestrationEvent & {
  readonly payload: { readonly threadId: ThreadId; readonly result: ReviewResult };
} =>
  event.aggregateKind === "thread" &&
  event.type === "thread.review-result-set" &&
  typeof (event.payload as { threadId?: unknown }).threadId === "string" &&
  Boolean((event.payload as { result?: unknown }).result);

/**
 * Hand parsed PR review findings to the canonical monitor pipeline so they become durable,
 * individually addressable items delivered to the owning chat. Ownership stays with the
 * existing monitor owner; only linkedReviewThreadId moves to the review chat.
 *
 * Consumption is at-least-once. At startup the hot live stream is attached and buffered
 * before the backlog is read (snapshot-first), so no event can fall between the two
 * sources; buffered events are only processed after the backlog replays successfully.
 * Handling is therefore strictly ascending, which
 * lets one watermark enforce the restart guarantee: after any event exhausts its retries,
 * cursor persistence freezes for the rest of the session, keeping the persisted cursor
 * behind that event. Later events still proceed without stalling (their submissions are
 * not lost), and a restart replays from behind the gap to re-attempt it; resubmitted
 * events are idempotent by content key. Settings gate the behaviour, and failures never
 * block the review itself.
 */
const makeReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const monitors = yield* PullRequestMonitorService;
  const serverSettings = yield* ServerSettingsService;
  const projectionState = yield* ProjectionStateRepository;

  const initial = yield* projectionState.getByProjector({ projector: REVIEW_HANDOFF_PROJECTOR });
  // Highest sequence fully handled this session; persisted until a permanent failure occurs.
  const processed = yield* Ref.make(
    Option.match(initial, {
      onNone: () => 0,
      onSome: (state) => state.lastAppliedSequence,
    }),
  );
  // Lowest sequence that exhausted retries this session, freezing further persistence.
  const failedFrom = yield* Ref.make<number | null>(null);

  const markHandled = Effect.fn("markHandled")(function* (sequence: number) {
    const current = yield* Ref.getAndUpdate(processed, (value) => Math.max(value, sequence));
    if (sequence <= current || (yield* Ref.get(failedFrom)) !== null) return;
    yield* projectionState
      .upsert({
        projector: REVIEW_HANDOFF_PROJECTOR,
        lastAppliedSequence: sequence,
        updatedAt: new Date().toISOString(),
      })
      .pipe(
        Effect.catchCause((cause) =>
          // Worst case the event replays after a restart; submits are idempotent.
          Effect.logWarning("pr review handoff cursor persist failed", {
            sequence,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  });

  const handle = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (!isHandoffEvent(event)) return;
      // Settings read errors propagate to process(): retried transiently like submit
      // failures so a transient settings outage cannot silently drop the findings.
      const settings = yield* serverSettings.getSettings;
      const readModel = yield* engine.getReadModel();
      const projectId = (readModel.threads.find((entry) => entry.id === event.payload.threadId)
        ?.projectId ?? null) as ProjectId | null;
      const review = handoffFromReviewResult({
        reviewThreadId: event.payload.threadId,
        projectId,
        result: event.payload.result,
      });
      if (review === null) return;
      const reference = {
        projectId: review.projectId,
        repository: review.repository,
        number: review.number,
      };
      const current = yield* monitors.status({ reference });
      // Finding visibility is unconditional. Monitoring startup is separate: never
      // resume a stopped monitor just because a child review completed.
      const startMonitoring =
        settings.autoMonitorPullRequestsOnCreate === true &&
        (current.monitor === null || current.monitor.enabled);
      yield* monitors.submitFindings({
        ...handoffToSubmitInput(review),
        startMonitoring,
      });
    });

  const process = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (event.sequence <= (yield* Ref.get(processed))) return;
      const outcome = yield* Effect.result(handle(event).pipe(Effect.retry(SUBMIT_RETRY)));
      if (Result.isSuccess(outcome)) {
        yield* markHandled(event.sequence);
        return;
      }
      // Keep looping: freeze persistence at this gap so a restart replays it, while later
      // events still proceed without stalling.
      yield* Ref.update(failedFrom, (current) =>
        current === null ? event.sequence : Math.min(current, event.sequence),
      );
      yield* Effect.logError("pr review handoff gave up; will retry after restart", {
        sequence: event.sequence,
        type: event.type,
      });
    });

  // Snapshot-first ordering with an explicit readiness boundary: the subscription is
  // registered synchronously while acquireDomainEventSubscription yields, so by the time
  // readEvents runs every live event is already being buffered — none can land after the
  // backlog snapshot but before attachment. Buffered events are only processed after the
  // backlog replays successfully; duplicates are dropped by the sequence check in
  // process().
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const subscription = yield* engine.acquireDomainEventSubscription;
      const startCursor = yield* Ref.get(processed);
      const replayed = yield* Effect.result(
        engine.readEvents(startCursor).pipe(Stream.runForEach(process), Effect.retry(REPLAY_RETRY)),
      );
      if (Result.isFailure(replayed)) {
        // Never release live handling past a backlog we failed to deliver. Keep draining
        // and discarding so the subscription buffer cannot grow until restart, which
        // re-attempts everything from the frozen cursor.
        yield* Effect.logError(
          "pr review handoff backlog replay failed; live handling paused until restart",
          { cause: replayed.failure },
        );
        yield* Stream.forever(Stream.fromEffect(PubSub.take(subscription))).pipe(
          Stream.runForEach(() => Effect.void),
        );
        return;
      }
      yield* Stream.forever(Stream.fromEffect(PubSub.take(subscription))).pipe(
        Stream.runForEach(process),
        Effect.catchCause((cause) =>
          Effect.logWarning("pr review handoff live stream terminated", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }).pipe(Effect.interruptible),
  );
});

export const layer = Layer.effectDiscard(makeReactor);
