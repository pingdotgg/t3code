import {
  CommandId,
  MessageId,
  PullRequestMonitorError,
  PullRequestMonitorFindings,
  PullRequestMonitorId,
  type PullRequestMonitorListInput,
  type PullRequestMonitorListResult,
  type PullRequestMonitorMutationResult,
  type PullRequestMonitorOwnerCandidate,
  type PullRequestMonitorRecord,
  type PullRequestMonitorStartInput,
  type PullRequestMonitorStatusInput,
  type PullRequestMonitorStatusResult,
  type PullRequestMonitorStopInput,
  type PullRequestMonitorReportInput,
  type PullRequestMonitorReportResult,
  type PullRequestMonitorContextInput,
  type PullRequestMonitorContextResult,
  type PullRequestMonitorTransferInput,
  type PullRequestMonitorSubmitFindingsInput,
  type PullRequestMonitorSubmitFindingsResult,
  type PullRequestMonitorLaunchFallbackInput,
  type PullRequestMonitorLaunchFallbackResult,
  type PullRequestMonitorFallbackReason,
  type PullRequestRef,
  type ThreadId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { GitManager } from "../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { automaticPrFeedbackBlockReason } from "@t3tools/shared/automaticPrFeedback";
import {
  formatPullRequestMonitorCanonicalKey,
  normalizeRepositoryIdentity,
  repositoryFromPullRequestUrl,
} from "./canonicalKey.ts";
import { diffPullRequestMonitorSnapshot, emptyCursor } from "./monitorDiff.ts";
import {
  abandonFallbackThread,
  createFallbackThread,
  interruptThreadTurn,
  requireProjectThread as requireProjectThreadDurable,
  resolveOwnerAvailability,
  resolveThreadActivity,
  startFallbackTurn,
  waitForThreadWorktree,
} from "./threadDelivery.ts";
import {
  LEASE_TTL_MS,
  nextPollDelayMs,
  POLL_BATCH_LIMIT,
  pollDelayMs,
  POLL_CONCURRENCY,
  rateLimitCooldownMs,
} from "./pollSchedule.ts";
import {
  PullRequestMonitorStore,
  type PullRequestMonitorPollLease,
} from "./PullRequestMonitorStore.ts";
import { computeReadiness, type PullRequestMonitorFeedbackReadiness } from "./readiness.ts";
import { PullRequestMonitorFeedbackService } from "./PullRequestMonitorFeedbackService.ts";
import { monitorToolNamesForThread } from "./monitorTools.ts";
import { buildFallbackMaintenancePrompt, formatBlockersSummary } from "./wakePrompt.ts";

/** Minimum gap between successful/attempted fallback launches per monitor. */
const FALLBACK_COOLDOWN_MS = 30 * 60 * 1000;
/** Exclusive claim while a fallback launch is materializing a worktree/thread. */
const FALLBACK_LAUNCH_LEASE_MS = 3 * 60 * 1000;
const decodePullRequestMonitorFindings = Schema.decodeUnknownEffect(PullRequestMonitorFindings);

function isoNow() {
  return Effect.map(DateTime.now, (now) => DateTime.formatIso(DateTime.toUtc(now)));
}

function addMs(iso: string, ms: number): string {
  return DateTime.formatIso(
    DateTime.toUtc(DateTime.add(DateTime.makeUnsafe(iso), { milliseconds: ms })),
  );
}

function monitorError(
  message: string,
  input?: { monitorId?: PullRequestMonitorId; cause?: unknown },
) {
  return new PullRequestMonitorError({
    message,
    ...(input?.monitorId === undefined ? {} : { monitorId: input.monitorId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

/** Failure text for durable monitor state; defects and typed errors read the same way. */
function describeCause(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error ? squashed.message : String(squashed);
}

export function associatedOwnerCandidates(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: PullRequestRef["projectId"];
    readonly title: string;
    readonly pullRequest?: { readonly number: number; readonly url: string } | null;
    readonly pullRequests?: ReadonlyArray<{
      readonly pullRequest: { readonly number: number; readonly url: string };
    }>;
    readonly archivedAt: string | null;
    readonly deletedAt: string | null;
  }>,
  reference: PullRequestRef,
): ReadonlyArray<PullRequestMonitorOwnerCandidate> {
  const referenceRepository = normalizeRepositoryIdentity(reference.repository);
  return threads
    .filter((thread) => {
      const associations = [
        ...(thread.pullRequest ? [thread.pullRequest] : []),
        ...(thread.pullRequests ?? []).map(({ pullRequest }) => pullRequest),
      ];
      return (
        thread.projectId === reference.projectId &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        associations.some((pullRequest) => {
          const repository = repositoryFromPullRequestUrl(pullRequest.url);
          return (
            pullRequest.number === reference.number &&
            repository !== null &&
            normalizeRepositoryIdentity(repository) === referenceRepository
          );
        })
      );
    })
    .map((thread) => ({ threadId: thread.id, title: thread.title }));
}

export class PullRequestMonitorService extends Context.Service<
  PullRequestMonitorService,
  {
    readonly start: (
      input: PullRequestMonitorStartInput,
    ) => Effect.Effect<PullRequestMonitorMutationResult, PullRequestMonitorError>;
    readonly stop: (
      input: PullRequestMonitorStopInput,
    ) => Effect.Effect<PullRequestMonitorMutationResult, PullRequestMonitorError>;
    readonly status: (
      input: PullRequestMonitorStatusInput,
    ) => Effect.Effect<PullRequestMonitorStatusResult, PullRequestMonitorError>;
    /** Cheap dispatch-boundary check for durable feedback queued to an owner thread. */
    readonly canDeliverAutomation: (input: {
      readonly reference: PullRequestRef;
      readonly threadId: ThreadId;
    }) => Effect.Effect<boolean, PullRequestMonitorError>;
    readonly list: (
      input: PullRequestMonitorListInput,
    ) => Effect.Effect<PullRequestMonitorListResult, PullRequestMonitorError>;
    readonly subscribeList: (
      input: PullRequestMonitorListInput,
    ) => Stream.Stream<PullRequestMonitorListResult, PullRequestMonitorError>;
    /**
     * Emits after a monitor observation or feedback mutation has committed.
     * Consumers must re-read authoritative context; the notification is only a
     * wake-up signal and carries no mutable evidence.
     */
    readonly subscribeChanges?: Stream.Stream<void>;
    readonly pollOnce: Effect.Effect<void>;
    readonly context: (
      input: PullRequestMonitorContextInput,
    ) => Effect.Effect<PullRequestMonitorContextResult, PullRequestMonitorError>;
    readonly report: (
      input: PullRequestMonitorReportInput,
    ) => Effect.Effect<PullRequestMonitorReportResult, PullRequestMonitorError>;
    readonly transferOwnership: (
      input: PullRequestMonitorTransferInput,
    ) => Effect.Effect<PullRequestMonitorMutationResult, PullRequestMonitorError>;
    readonly submitFindings: (
      input: PullRequestMonitorSubmitFindingsInput,
    ) => Effect.Effect<PullRequestMonitorSubmitFindingsResult, PullRequestMonitorError>;
    readonly launchFallback: (
      input: PullRequestMonitorLaunchFallbackInput,
    ) => Effect.Effect<PullRequestMonitorLaunchFallbackResult, PullRequestMonitorError>;
  }
>()("t3/pullRequestMonitor/PullRequestMonitorService") {}

export const layer = Layer.effect(
  PullRequestMonitorService,
  Effect.gen(function* () {
    const store = yield* PullRequestMonitorStore.make;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const feedback = yield* PullRequestMonitorFeedbackService;
    const serverSettings = yield* ServerSettingsService;
    const projections = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const git = yield* GitManager;
    const crypto = yield* Crypto.Crypto;
    const pollSweepLock = Semaphore.makeUnsafe(1);
    const ownerId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const changes = yield* PubSub.sliding<void>(1);
    const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

    const ownerAvailability = (ownerThreadId: ThreadId | null) =>
      resolveOwnerAvailability(ownerThreadId).pipe(
        Effect.provideService(ProjectionSnapshotQuery, projections),
      );

    const requireProjectThread = (input: {
      projectId: PullRequestMonitorRecord["projectId"];
      threadId: ThreadId;
    }) =>
      requireProjectThreadDurable(input).pipe(
        Effect.provideService(ProjectionSnapshotQuery, projections),
        Effect.mapError((cause) =>
          monitorError("Target thread is missing, deleted, or outside this monitor project.", {
            cause,
          }),
        ),
      );

    const resolveMonitor = (input: {
      readonly monitorId?: PullRequestMonitorId | undefined;
      readonly reference?: PullRequestRef | undefined;
    }) =>
      Effect.gen(function* () {
        if (input.monitorId) {
          const byId = yield* store.getById(input.monitorId);
          if (byId) return byId;
        }
        if (input.reference) {
          const byRef = yield* store.getByProjectRef({
            projectId: input.reference.projectId,
            repository: input.reference.repository,
            number: input.reference.number,
          });
          if (byRef) return byRef;
        }
        return yield* monitorError("Pull request monitor was not found.");
      });

    const list = (input: PullRequestMonitorListInput = {}) =>
      store
        .list({
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(input.enabledOnly !== undefined ? { enabledOnly: input.enabledOnly } : {}),
        })
        .pipe(Effect.map((monitors) => ({ monitors })));

    const automationBlockReason = (monitor: PullRequestMonitorRecord, settings: ServerSettings) =>
      Effect.gen(function* () {
        const owner = monitor.ownerThreadId
          ? yield* projections.getThreadShellById(monitor.ownerThreadId)
          : Option.none();
        const shell = Option.getOrNull(owner);
        const target =
          shell && shell.archivedAt === null
            ? shell.modelSelection.instanceId
            : settings.textGenerationModelSelection.instanceId;
        return automaticPrFeedbackBlockReason(settings, target, shell?.session);
      });

    const automationReason = (input: {
      readonly monitor: PullRequestMonitorRecord;
      readonly openFeedback: ReadonlyArray<{
        readonly status: string;
        readonly disposition?: string | null | undefined;
        readonly reviewerDisposition?: string | null | undefined;
      }>;
      readonly deliveries: ReadonlyArray<{ readonly status: string }>;
    }) => {
      const needsHuman = input.openFeedback.some(
        (item) => item.disposition === "needs-human" || item.reviewerDisposition === "needs-human",
      );
      if (needsHuman) {
        return {
          kind: "needs-human" as const,
          code: "feedback-needs-human",
          detail: "A review finding requires explicit human adjudication.",
        };
      }
      if (!input.monitor.enabled || input.monitor.status === "stopped") {
        return {
          kind: "monitoring-paused" as const,
          code: input.monitor.status === "stopped" ? "stopped" : "disabled",
          detail: input.monitor.lastError ?? "Pull request monitoring is paused.",
        };
      }
      if (
        input.deliveries.some(
          (delivery) => delivery.status === "pending" || delivery.status === "failed",
        )
      ) {
        return {
          kind: "waiting-automatic" as const,
          code: "delivery-pending",
          detail: "Automatic review feedback is waiting for durable delivery.",
        };
      }
      return undefined;
    };

    const status = (input: PullRequestMonitorStatusInput) =>
      Effect.gen(function* () {
        const monitor = yield* resolveMonitor(input).pipe(
          Effect.catchTag("PullRequestMonitorError", () => Effect.succeed(null)),
        );
        const reference =
          input.reference ??
          (monitor === null
            ? null
            : {
                projectId: monitor.projectId,
                repository: monitor.repository,
                number: monitor.number,
              });
        const ownerCandidates =
          reference === null
            ? []
            : associatedOwnerCandidates((yield* engine.getReadModel()).threads, reference);
        if (!monitor) {
          return {
            monitor: null,
            ownerCandidates,
            latestSnapshot: null,
            recentEvents: [],
            openFeedback: [],
            recentDeliveries: [],
            recentReports: [],
          };
        }
        const latest = yield* store.latestSnapshot(monitor.id);
        const openFeedback = yield* feedback.listOpenItems(monitor.id);
        const recentDeliveries = yield* feedback.listDeliveries(monitor.id);
        const recentReports = yield* feedback.listReports(monitor.id);
        const derivedAutomationReason = automationReason({
          monitor,
          openFeedback,
          deliveries: recentDeliveries,
        });
        const blockReason =
          monitor.enabled && openFeedback.length > 0
            ? yield* serverSettings.getSettings.pipe(
                Effect.flatMap((settings) => automationBlockReason(monitor, settings)),
                Effect.mapError((cause) =>
                  monitorError("Could not resolve automatic PR feedback policy.", { cause }),
                ),
              )
            : null;
        return {
          monitor,
          ...(blockReason ? { automationBlockReason: blockReason } : {}),
          ...(derivedAutomationReason ? { automationReason: derivedAutomationReason } : {}),
          ownerCandidates,
          latestSnapshot: latest?.snapshot ?? null,
          recentEvents: latest?.events ?? [],
          openFeedback,
          recentDeliveries,
          recentReports,
        };
      });

    const canDeliverAutomation: PullRequestMonitorService["Service"]["canDeliverAutomation"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const monitor = yield* store.getByProjectRef(input.reference);
        if (
          monitor === null ||
          !monitor.enabled ||
          monitor.status === "stopped" ||
          monitor.status === "terminal" ||
          monitor.ownerThreadId !== input.threadId
        ) {
          return false;
        }
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((cause) =>
            monitorError("Could not resolve automatic PR feedback policy.", { cause }),
          ),
        );
        return settings.autoMonitorPullRequestsOnCreate;
      });

    const start = (input: PullRequestMonitorStartInput) =>
      Effect.gen(function* () {
        if (input.ownerThreadId !== undefined && input.requireAssociatedOwner === true) {
          const candidates = associatedOwnerCandidates((yield* engine.getReadModel()).threads, {
            projectId: input.projectId,
            repository: input.repository,
            number: input.number,
          });
          if (!candidates.some((candidate) => candidate.threadId === input.ownerThreadId)) {
            return yield* monitorError(
              "The selected owner chat is not actively associated with this pull request.",
            );
          }

          const automaticExisting = yield* store.getByProjectRef(input);
          if (
            automaticExisting !== null &&
            (!automaticExisting.enabled || automaticExisting.status === "terminal")
          ) {
            return { monitor: automaticExisting };
          }
        }

        // Fresh detail resolves host/provider identity; never trust client-only identity.
        const detail = yield* pullRequests
          .detail(input)
          .pipe(
            Effect.mapError((cause) =>
              monitorError("Could not resolve pull request for monitoring.", { cause }),
            ),
          );

        const host = (() => {
          try {
            return new URL(detail.url).host;
          } catch {
            return detail.provider === "github" ? "github.com" : detail.provider;
          }
        })();

        const canonical = formatPullRequestMonitorCanonicalKey({
          provider: detail.provider,
          host,
          repository: detail.repository,
          number: detail.number,
        });

        const existing = yield* store.getByCanonicalKey(canonical);
        const now = yield* isoNow();

        if (existing) {
          if (existing.projectId !== input.projectId) {
            return yield* monitorError(
              "This pull request is already monitored by another project.",
              { monitorId: existing.id },
            );
          }
          if (input.ownerMode === "preserve") {
            if (existing.ownerThreadId === null && input.ownerThreadId !== undefined) {
              yield* requireProjectThread({
                projectId: existing.projectId,
                threadId: input.ownerThreadId,
              });
            }
            const resumed: PullRequestMonitorRecord = {
              ...existing,
              status: "monitoring",
              enabled: true,
              lastError: null,
              nextPollAt: now,
              updatedAt: now,
              stoppedAt: null,
            };
            yield* store.updatePollState(resumed, undefined, { allowReenable: true });
            if (existing.ownerThreadId === null && input.ownerThreadId !== undefined) {
              yield* store.transferOwnershipAtomic({
                monitorId: existing.id,
                ownerThreadId: input.ownerThreadId,
                expectedOwnerThreadId: null,
                updatedAt: now,
                eventId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
                toThreadId: input.ownerThreadId,
                reason: "start-preserve",
              });
            }
            const current = yield* store.getById(existing.id);
            if (!current) {
              return yield* monitorError("Monitor no longer exists.", {
                monitorId: existing.id,
              });
            }
            yield* notify;
            yield* pollMonitor(current).pipe(Effect.ignore);
            const fresh = yield* store.getById(current.id);
            return { monitor: fresh ?? current };
          }
          const nextOwner =
            input.ownerMode === "observe-only"
              ? null
              : (input.ownerThreadId ?? existing.ownerThreadId);
          // Ownership-scoped write so a concurrent poll cannot be clobbered by start().
          if (nextOwner !== existing.ownerThreadId) {
            if (nextOwner !== null) {
              yield* requireProjectThread({ projectId: existing.projectId, threadId: nextOwner });
            }
            yield* store.transferOwnershipAtomic({
              monitorId: existing.id,
              ownerThreadId: nextOwner,
              updatedAt: now,
              eventId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
              toThreadId: nextOwner,
              reason: nextOwner === null ? "start-observe-only" : "start-owner-associate",
            });
          }
          const resumed: PullRequestMonitorRecord = {
            ...existing,
            projectId: input.projectId,
            ownerThreadId: nextOwner,
            linkedReviewThreadId: existing.linkedReviewThreadId ?? null,
            status: "monitoring",
            enabled: true,
            lastError: null,
            nextPollAt: now,
            updatedAt: now,
            stoppedAt: null,
          };
          // Explicit resume may re-enable after stop; poll commits cannot.
          yield* store.updatePollState(resumed, undefined, { allowReenable: true });
          yield* notify;
          // Kick an immediate observe pass for the resumed monitor.
          yield* pollMonitor(resumed).pipe(Effect.ignore);
          const fresh = yield* store.getById(resumed.id);
          return { monitor: fresh ?? resumed };
        }

        const ownerThreadId = input.ownerThreadId ?? null;
        if (ownerThreadId !== null) {
          yield* requireProjectThread({ projectId: input.projectId, threadId: ownerThreadId });
        }

        const id = PullRequestMonitorId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const record: PullRequestMonitorRecord = {
          id,
          canonicalKey: canonical,
          provider: detail.provider,
          host,
          repository: detail.repository,
          number: detail.number,
          projectId: input.projectId,
          ownerThreadId,
          linkedReviewThreadId: null,
          status: "monitoring",
          enabled: true,
          readiness: null,
          headSha: null,
          sourceRevision: null,
          lastPolledAt: null,
          nextPollAt: now,
          lastError: null,
          pollFailureCount: 0,
          createdAt: now,
          updatedAt: now,
          stoppedAt: null,
        };
        yield* store.insert(record, emptyCursor());
        yield* notify;
        yield* pollMonitor(record).pipe(Effect.ignore);
        const fresh = yield* store.getById(id);
        return { monitor: fresh ?? record };
      });

    const stop = (input: PullRequestMonitorStopInput) =>
      Effect.gen(function* () {
        const monitor = yield* resolveMonitor(input);
        const now = yield* isoNow();
        const stopped: PullRequestMonitorRecord = {
          ...monitor,
          enabled: false,
          status: "stopped",
          nextPollAt: null,
          updatedAt: now,
          stoppedAt: now,
        };
        // Poll/lifecycle fields only — preserve concurrent ownership handoffs.
        yield* store.updatePollState(stopped);
        yield* notify;
        return { monitor: stopped };
      });

    /**
     * Records an attempt failure under the exact generation that owns the attempt, at the
     * clock as it stands now. A worker whose lease already expired — or was replaced by a
     * newer attempt that succeeded — writes nothing.
     */
    const recordAttemptFailure = (input: {
      readonly monitor: PullRequestMonitorRecord;
      readonly lease: PullRequestMonitorPollLease;
      readonly message: string;
    }) =>
      Effect.gen(function* () {
        const now = yield* isoNow();
        const failureCount = input.monitor.pollFailureCount + 1;
        const delay = yield* nextPollDelayMs({
          readiness: input.monitor.readiness,
          failureCount,
          hadActionableEvents: false,
        });
        yield* store.updatePollState(
          {
            ...input.monitor,
            status: "error",
            lastError: input.message.slice(0, 1000),
            pollFailureCount: failureCount,
            lastPolledAt: now,
            nextPollAt: addMs(now, delay),
            updatedAt: now,
          },
          undefined,
          { lease: input.lease, nowIso: now },
        );
        yield* notify;
      }).pipe(Effect.ignore);

    /** One claimed attempt: every durable write it makes is fenced by `lease`. */
    const runPollAttempt = (
      monitor: PullRequestMonitorRecord,
      lease: PullRequestMonitorPollLease,
    ) =>
      Effect.gen(function* () {
        const hostKey = `${monitor.provider}:${monitor.host}`;
        const startedAt = yield* isoNow();
        const cooldownUntil = yield* store.getHostCooldownUntil(hostKey, startedAt);
        if (cooldownUntil) {
          const deferred: PullRequestMonitorRecord = {
            ...monitor,
            nextPollAt: cooldownUntil,
            updatedAt: startedAt,
          };
          yield* store.updatePollState(deferred, undefined, { lease, nowIso: startedAt });
          return;
        }

        const cursor = yield* store.getCursor(monitor.id);
        const snapshotResult = yield* Effect.result(
          pullRequests.monitorSnapshot({
            projectId: monitor.projectId,
            repository: monitor.repository,
            number: monitor.number,
          }),
        );

        if (Result.isFailure(snapshotResult)) {
          const message =
            snapshotResult.failure instanceof Error
              ? snapshotResult.failure.message
              : String(snapshotResult.failure);
          if (/rate limit|secondary rate|403/i.test(message)) {
            // Host cooldown is advisory and host-scoped, so it is recorded even when the
            // attempt itself turns out to be fenced; it never touches monitor state.
            const failedAt = yield* isoNow();
            yield* store.setHostCooldown({
              hostKey,
              cooldownUntil: addMs(failedAt, rateLimitCooldownMs(monitor.pollFailureCount + 1)),
              reason: message.slice(0, 300),
              nowIso: failedAt,
            });
          }
          // Single fenced failure path: the handler below owns every error write.
          return yield* monitorError(message, { monitorId: monitor.id });
        }

        const snapshot = snapshotResult.success;
        const { actionableEvents, nextCursor } = diffPullRequestMonitorSnapshot(cursor, snapshot);
        // Sampled before the transaction so the commit stays a pure function of state.
        const delayJitter = yield* Random.next;

        const finalize = (
          feedbackReadiness: PullRequestMonitorFeedbackReadiness,
          commitAt: string,
        ) => {
          const readiness = computeReadiness(snapshot, feedbackReadiness);
          let status: PullRequestMonitorRecord["status"] = "monitoring";
          if (snapshot.state !== "open") status = "terminal";
          else if (readiness.ready) status = "ready";
          // Ready PRs stay monitored slowly; terminal PRs stop polling.
          const enabled = status !== "terminal";
          const delay = pollDelayMs(
            {
              readiness,
              failureCount: 0,
              hadActionableEvents: actionableEvents.length > 0,
            },
            delayJitter,
          );
          const record: PullRequestMonitorRecord = {
            ...monitor,
            status,
            enabled,
            readiness,
            headSha: snapshot.headSha,
            sourceRevision: snapshot.sourceRevision,
            lastPolledAt: commitAt,
            nextPollAt: enabled ? addMs(commitAt, delay) : null,
            lastError: null,
            pollFailureCount: 0,
            updatedAt: commitAt,
            stoppedAt: enabled ? null : commitAt,
          };
          return { record, readiness };
        };

        const snapshotId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        // Snapshot audit, feedback reconciliation/ingestion, and the cursor advance are
        // one fenced transaction: an observation is never half-recorded.
        const commit = yield* store.commitPollObservation({
          lease,
          cursor: nextCursor,
          snapshotId,
          snapshot,
          events: actionableEvents,
          ingest: feedback.reconcileAndIngest({
            monitor,
            snapshot,
            events: actionableEvents,
          }),
          finalize,
        });
        if (!commit.committed || commit.record === null) return;
        const updated = commit.record;

        // Auto fallback only when owner is explicitly missing/unavailable and there is work.
        // Fail closed on settings/read errors and operational projection failures.
        if (
          snapshot.state === "open" &&
          updated.enabled &&
          (actionableEvents.length > 0 || (yield* feedback.listOpenItems(updated.id)).length > 0)
        ) {
          const availability = yield* ownerAvailability(updated.ownerThreadId);
          if (availability.kind === "unavailable") {
            const settingsResult = yield* Effect.result(serverSettings.getSettings);
            if (
              Result.isSuccess(settingsResult) &&
              settingsResult.success.autoLaunchPrMonitorFallback === true &&
              (yield* automationBlockReason(updated, settingsResult.success)) === null
            ) {
              yield* launchFallback(
                {
                  monitorId: updated.id,
                  reason: availability.reason,
                },
                settingsResult.success,
              ).pipe(Effect.ignore);
            }
          }
        }

        yield* notify;
      });

    const pollMonitor = (monitor: PullRequestMonitorRecord): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* isoNow();
        // One attempt, one fence. Every write below carries this generation so a
        // superseded or expired attempt cannot commit stale observations.
        const attemptId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const lease = yield* store.tryAcquireLease({
          canonicalKey: monitor.canonicalKey,
          ownerId: `${ownerId}:${attemptId}`,
          nowIso: now,
          expiresAt: addMs(now, LEASE_TTL_MS),
        });
        if (!lease) return;

        yield* runPollAttempt(monitor, lease).pipe(
          // The failure handler belongs to the attempt: it runs while this generation's
          // lease row still exists, and its write is fenced by that generation.
          Effect.catchCause((cause) =>
            recordAttemptFailure({ monitor, lease, message: describeCause(cause) }),
          ),
          Effect.ensuring(store.releaseLease(lease).pipe(Effect.ignore)),
        );
      }).pipe(
        // Nothing was claimed, so this attempt has no authority over monitor state; a
        // newer attempt's result must never be clobbered by a failure that predates it.
        Effect.catchCause((cause) =>
          Effect.logWarning("pull request monitor poll could not start an attempt", {
            monitorId: monitor.id,
            cause: describeCause(cause),
          }).pipe(Effect.ignore),
        ),
      );

    /**
     * Crash recovery: a launch that never reached a terminal stage is reconciled so a
     * half-materialized handoff cannot linger as a phantom owner.
     */
    const reconcileStaleFallbackLaunches = Effect.gen(function* () {
      const now = yield* isoNow();
      const stale = yield* store.listStaleFallbackLaunches({
        olderThan: addMs(now, -FALLBACK_LAUNCH_LEASE_MS),
        limit: 16,
      });
      for (const launch of stale) {
        const monitorId = PullRequestMonitorId.make(launch.monitorId);
        const monitor = yield* store.getById(monitorId);
        const threadId = launch.threadId as ThreadId | null;
        const ownsMonitor = threadId !== null && monitor?.ownerThreadId === threadId;
        if (threadId !== null && !ownsMonitor) {
          // The thread never became the owner; tear it down rather than leave a second modifier.
          yield* abandonFallback({
            projectId: monitor?.projectId ?? ("" as PullRequestMonitorRecord["projectId"]),
            threadId,
            commandIdPrefix: launch.commandId,
          }).pipe(Effect.ignore);
        }
        yield* store.recordFallbackLaunch({
          launchId: launch.launchId,
          monitorId,
          commandId: launch.commandId,
          threadId,
          reason: launch.reason,
          status: threadId !== null && !ownsMonitor ? "abandoned" : "failed",
          error: `Fallback launch was interrupted at stage '${launch.status}'.`,
          createdAt: launch.createdAt,
        });
      }
    }).pipe(Effect.ignore);

    const pollOnce = pollSweepLock.withPermits(1)(
      Effect.gen(function* () {
        yield* reconcileStaleFallbackLaunches;
        const now = yield* isoNow();
        const due = yield* store.listDue(now, POLL_BATCH_LIMIT);
        yield* Effect.forEach(due, (monitor) => pollMonitor(monitor), {
          concurrency: POLL_CONCURRENCY,
        });
      }).pipe(Effect.ignore),
    );

    // Background adaptive poller. Observe-only: no turn steering.
    yield* pollOnce.pipe(
      Effect.andThen(Effect.sleep(Duration.seconds(15))),
      Effect.forever,
      Effect.forkScoped,
      Effect.interruptible,
    );

    const requestRecheck = (monitor: PullRequestMonitorRecord) =>
      Effect.gen(function* () {
        const now = yield* isoNow();
        yield* store.scheduleRecheck({
          monitorId: monitor.id,
          nextPollAt: now,
          updatedAt: now,
        });
        yield* notify;
      });

    const context = (input: PullRequestMonitorContextInput) =>
      feedback.context({
        ...input,
        resolveMonitor: () =>
          resolveMonitor({
            ...(input.monitorId === undefined ? {} : { monitorId: input.monitorId }),
            ...(input.reference === undefined ? {} : { reference: input.reference }),
          }).pipe(Effect.catchTag("PullRequestMonitorError", () => Effect.succeed(null))),
      });

    const report = (input: PullRequestMonitorReportInput) =>
      feedback.report({
        ...input,
        resolveMonitor: () =>
          resolveMonitor({
            ...(input.monitorId === undefined ? {} : { monitorId: input.monitorId }),
            ...(input.reference === undefined ? {} : { reference: input.reference }),
          }),
        requestRecheck,
      });

    const transferOwnership = (input: PullRequestMonitorTransferInput) =>
      Effect.gen(function* () {
        const monitor = yield* resolveMonitor(input);
        if (monitor.ownerThreadId === input.toThreadId) {
          return { monitor };
        }
        yield* requireProjectThread({ projectId: monitor.projectId, threadId: input.toThreadId });
        // Never allow two concurrent modifying owners: transfer replaces the single owner.
        const now = yield* isoNow();
        const updated = {
          ...monitor,
          ownerThreadId: input.toThreadId,
          updatedAt: now,
        };
        yield* store.transferOwnershipAtomic({
          monitorId: monitor.id,
          ownerThreadId: input.toThreadId,
          updatedAt: now,
          eventId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
          toThreadId: input.toThreadId,
          reason: input.reason ?? "transfer",
        });
        yield* notify;
        return { monitor: updated };
      });

    const submitFindings = (input: PullRequestMonitorSubmitFindingsInput) =>
      Effect.gen(function* () {
        yield* decodePullRequestMonitorFindings(input.findings ?? []).pipe(
          Effect.mapError((cause) =>
            monitorError("Invalid review findings submission.", { cause }),
          ),
        );
        yield* requireProjectThread({
          projectId: input.reference.projectId,
          threadId: input.reviewThreadId,
        });
        const startMonitoring = input.startMonitoring !== false;
        let monitorRecord: PullRequestMonitorRecord;
        if (startMonitoring) {
          const started = yield* start({
            projectId: input.reference.projectId,
            repository: input.reference.repository,
            number: input.reference.number,
          });
          monitorRecord = started.monitor;
        } else {
          const existing = yield* store.getByProjectRef(input.reference);
          if (existing !== null) {
            monitorRecord = existing;
          } else {
            // Findings still need a durable PR ledger when automatic monitoring is
            // disabled. Create a stopped record without polling or waking an agent.
            const detail = yield* pullRequests
              .detail(input.reference)
              .pipe(
                Effect.mapError((cause) =>
                  monitorError("Could not resolve pull request for review findings.", { cause }),
                ),
              );
            const host = (() => {
              try {
                return new URL(detail.url).host;
              } catch {
                return detail.provider === "github" ? "github.com" : detail.provider;
              }
            })();
            const canonicalKey = formatPullRequestMonitorCanonicalKey({
              provider: detail.provider,
              host,
              repository: detail.repository,
              number: detail.number,
            });
            const now = yield* isoNow();
            const record: PullRequestMonitorRecord = {
              id: PullRequestMonitorId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
              canonicalKey,
              provider: detail.provider,
              host,
              repository: detail.repository,
              number: detail.number,
              projectId: input.reference.projectId,
              ownerThreadId: null,
              linkedReviewThreadId: null,
              status: "stopped",
              enabled: false,
              readiness: null,
              headSha: null,
              sourceRevision: null,
              lastPolledAt: null,
              nextPollAt: null,
              lastError: null,
              pollFailureCount: 0,
              createdAt: now,
              updatedAt: now,
              stoppedAt: now,
            };
            yield* store.insert(record, emptyCursor());
            yield* notify;
            monitorRecord = record;
          }
        }

        // The monitor row can be empty or stale when its opportunistic start poll failed or
        // lost a lease. A fresh provider snapshot supplies the immutable head provenance for
        // every parent-agent finding, not only for explicitly head-tagged submissions.
        const currentSnapshot =
          (input.findings !== undefined && input.findings.length > 0) ||
          input.reviewedHeadSha !== undefined
            ? yield* pullRequests
                .monitorSnapshot(input.reference)
                .pipe(
                  Effect.mapError((cause) =>
                    monitorError("Could not verify the reviewed pull request revision.", { cause }),
                  ),
                )
            : null;
        const reviewedHeadSha = input.reviewedHeadSha ?? currentSnapshot?.headSha;
        let recoveredOwnerThreadId: ThreadId | null = null;
        if (input.ownerThreadId === undefined && monitorRecord.ownerThreadId === null) {
          const ownerCandidates = associatedOwnerCandidates(
            (yield* engine.getReadModel()).threads,
            input.reference,
          );
          if (ownerCandidates.length === 1) {
            recoveredOwnerThreadId = ownerCandidates[0]!.threadId;
          }
        }
        const ownerThreadId =
          input.ownerThreadId ?? monitorRecord.ownerThreadId ?? recoveredOwnerThreadId;
        if (ownerThreadId !== null) {
          yield* requireProjectThread({
            projectId: monitorRecord.projectId,
            threadId: ownerThreadId,
          });
        }
        const now = yield* isoNow();
        const updated = {
          ...monitorRecord,
          linkedReviewThreadId: input.reviewThreadId,
          ownerThreadId,
          updatedAt: now,
        };
        // Each finding becomes its own durable item/revision so the owner can disposition
        // them individually; delivery follows the normal debounced wake path.
        const findings = yield* feedback.ingestFindings({
          monitor:
            currentSnapshot === null
              ? monitorRecord
              : {
                  ...monitorRecord,
                  headSha: currentSnapshot.headSha,
                  sourceRevision: currentSnapshot.sourceRevision,
                },
          reviewThreadId: input.reviewThreadId,
          findings: input.findings ?? [],
          ...(reviewedHeadSha === undefined ? {} : { reviewedHeadSha }),
          origin: input.origin ?? "reviewer",
        });
        // Always use ownership-scoped SQL so concurrent poll updates cannot clobber the link.
        yield* store.transferOwnershipAtomic({
          monitorId: updated.id,
          ownerThreadId,
          linkedReviewThreadId: input.reviewThreadId,
          updatedAt: now,
          eventId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
          toThreadId: ownerThreadId,
          reason: input.summary?.slice(0, 500) ?? "review-handoff",
        });
        yield* notify;
        yield* requestRecheck(updated);
        return {
          monitor: updated,
          linkedReviewThreadId: input.reviewThreadId,
          ownerThreadId,
          monitoringStarted: startMonitoring,
          findings,
        };
      });

    /** Bounded wait for a thread to stop working after an interrupt. */
    const waitForThreadIdle = (threadId: ThreadId) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 20; attempt++) {
          const activity = yield* resolveThreadActivity(threadId).pipe(
            Effect.provideService(ProjectionSnapshotQuery, projections),
          );
          if (activity.kind === "idle" || activity.kind === "missing") return true;
          if (activity.kind === "unknown") return false;
          yield* Effect.sleep("500 millis");
        }
        return false;
      });

    const waitForPreparedWorktree = (threadId: ThreadId) =>
      waitForThreadWorktree(threadId).pipe(
        Effect.provideService(ProjectionSnapshotQuery, projections),
      );

    const abandonFallback = (input: {
      readonly projectId: PullRequestMonitorRecord["projectId"];
      readonly threadId: ThreadId;
      readonly commandIdPrefix: string;
    }) =>
      abandonFallbackThread({
        threadId: input.threadId,
        commandIdPrefix: input.commandIdPrefix,
      }).pipe(Effect.provideService(OrchestrationEngineService, engine));

    const launchFallback = (
      input: PullRequestMonitorLaunchFallbackInput,
      settings: ServerSettings,
    ): Effect.Effect<PullRequestMonitorLaunchFallbackResult, PullRequestMonitorError> =>
      Effect.gen(function* () {
        const monitor = yield* resolveMonitor(input);
        if (!monitor.enabled || monitor.status === "terminal") {
          return yield* monitorError("Monitor is not active for fallback launch.", {
            monitorId: monitor.id,
          });
        }

        const force = input.force === true;
        const now = yield* isoNow();
        const previousOwner = monitor.ownerThreadId;
        const availability = yield* ownerAvailability(previousOwner);
        if (availability.kind === "unknown") {
          return yield* monitorError(
            "Could not verify owner thread availability; refusing fallback takeover.",
            { monitorId: monitor.id, cause: availability.cause },
          );
        }
        if (availability.kind === "available" && !force) {
          // Cooldown only short-circuits when the recorded fallback owner is still alive.
          const latest = yield* store.latestFallbackLaunch(monitor.id);
          if (latest && latest.status === "launched") {
            const age =
              DateTime.toEpochMillis(DateTime.makeUnsafe(now)) -
              DateTime.toEpochMillis(DateTime.makeUnsafe(latest.createdAt));
            const existingThread = latest.threadId as ThreadId | null;
            if (
              age >= 0 &&
              age < FALLBACK_COOLDOWN_MS &&
              existingThread &&
              previousOwner === existingThread
            ) {
              return {
                monitor,
                fallbackThreadId: existingThread,
                previousOwnerThreadId: null,
                launched: false,
                skippedReason: "recent-fallback-cooldown",
                commandId: latest.commandId,
              };
            }
          }
          return yield* monitorError(
            "Owner thread is still available. Use force only with explicit human approval, or transfer ownership first.",
            { monitorId: monitor.id },
          );
        }

        // Serialize concurrent fallback attempts (RPC + auto path) with a short exclusive lease.
        const attemptId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const fallbackLeaseKey = `fallback:${monitor.canonicalKey}`;
        const fallbackLease = yield* store.tryAcquireLease({
          canonicalKey: fallbackLeaseKey,
          ownerId: attemptId,
          nowIso: now,
          expiresAt: addMs(now, FALLBACK_LAUNCH_LEASE_MS),
        });
        if (!fallbackLease) {
          const latest = yield* store.latestFallbackLaunch(monitor.id);
          const inflightThread = latest?.threadId as ThreadId | null | undefined;
          if (latest && inflightThread) {
            return {
              monitor,
              fallbackThreadId: inflightThread,
              previousOwnerThreadId: null,
              launched: false,
              skippedReason: "fallback-launch-in-flight",
              commandId: latest.commandId,
            };
          }
          return yield* monitorError(
            "Another fallback launch is already in progress for this monitor.",
            {
              monitorId: monitor.id,
            },
          );
        }

        return yield* Effect.gen(function* () {
          const reason: PullRequestMonitorFallbackReason =
            input.reason ??
            (force
              ? "explicit"
              : availability.kind === "unavailable" && availability.reason === "owner-missing"
                ? "owner-missing"
                : "owner-unavailable");
          const commandIdValue = `command:pr-monitor-fallback:${monitor.id}:${attemptId}`;

          // Durable intent first: a crash after any side effect below must still be
          // reconcilable back to a terminal stage by the recovery sweep.
          yield* store.recordFallbackLaunch({
            launchId: attemptId,
            monitorId: monitor.id,
            commandId: commandIdValue,
            threadId: null,
            reason,
            status: "claimed",
            error: null,
            createdAt: now,
          });

          const failLaunch = (input: {
            readonly message: string;
            readonly threadId: ThreadId | null;
            readonly cause?: unknown;
          }) =>
            Effect.gen(function* () {
              yield* store.recordFallbackLaunch({
                launchId: attemptId,
                monitorId: monitor.id,
                commandId: commandIdValue,
                threadId: input.threadId,
                reason,
                status: "failed",
                error: input.message.slice(0, 1000),
                createdAt: now,
              });
              return yield* monitorError(input.message, {
                monitorId: monitor.id,
                ...(input.cause === undefined ? {} : { cause: input.cause }),
              });
            });

          // Never run two modifying agents on one PR: the previous owner must be settled
          // before ownership moves, and an unavailable owner mid-turn is interrupted first.
          if (previousOwner !== null) {
            const activity = yield* resolveThreadActivity(previousOwner).pipe(
              Effect.provideService(ProjectionSnapshotQuery, projections),
            );
            if (activity.kind === "unknown") {
              return yield* failLaunch({
                message: "Could not verify previous owner activity; refusing fallback takeover.",
                threadId: null,
                cause: activity.cause,
              });
            }
            if (activity.kind === "busy") {
              yield* interruptThreadTurn({
                threadId: previousOwner,
                commandId: CommandId.make(`${commandIdValue}:interrupt-owner`),
              }).pipe(Effect.provideService(OrchestrationEngineService, engine));
              const settled = yield* waitForThreadIdle(previousOwner);
              if (!settled) {
                return yield* failLaunch({
                  message:
                    "Previous owner thread is still working after an interrupt; refusing fallback takeover.",
                  threadId: null,
                });
              }
            }
          }

          const snapshotResult = yield* Effect.result(
            pullRequests.monitorSnapshot({
              projectId: monitor.projectId,
              repository: monitor.repository,
              number: monitor.number,
            }),
          );
          if (Result.isFailure(snapshotResult)) {
            return yield* failLaunch({
              message: "Could not load PR snapshot for fallback launch.",
              threadId: null,
              cause: snapshotResult.failure,
            });
          }
          const snapshot = snapshotResult.success;
          if (snapshot.state !== "open") {
            return yield* failLaunch({
              message: "Pull request is not open; refusing fallback launch.",
              threadId: null,
            });
          }

          const commandId = CommandId.make(commandIdValue);
          const messageId = MessageId.make(
            `message:pr-monitor-fallback:${monitor.id}:${attemptId}`,
          );
          const readiness = monitor.readiness ?? {
            ready: false,
            label: "blocked" as const,
            blockers: [{ kind: "checks-missing" as const, detail: "No readiness yet" }],
          };
          const projectShellResult = yield* Effect.result(
            projections.getProjectShellById(monitor.projectId),
          );
          if (Result.isFailure(projectShellResult) || Option.isNone(projectShellResult.success)) {
            return yield* failLaunch({
              message: "Could not resolve project for fallback launch.",
              threadId: null,
              ...(Result.isFailure(projectShellResult)
                ? { cause: projectShellResult.failure }
                : {}),
            });
          }
          const projectShell = projectShellResult.success.value;

          // Materialize refs/pull/<n>/head (and fork heads) before creating a thread worktree.
          const prCheckout = yield* Effect.result(
            git.preparePullRequestThread({
              cwd: projectShell.workspaceRoot,
              reference: `#${monitor.number}`,
              mode: "worktree",
            }),
          );
          if (Result.isFailure(prCheckout)) {
            const message =
              prCheckout.failure instanceof Error
                ? prCheckout.failure.message
                : String(prCheckout.failure);
            return yield* failLaunch({
              message: `Could not materialize PR head for fallback launch: ${message.slice(0, 300)}`,
              threadId: null,
              cause: prCheckout.failure,
            });
          }
          if (
            prCheckout.success.worktreePath === null ||
            prCheckout.success.worktreePath.length === 0
          ) {
            return yield* failLaunch({
              message: "PR head preparation did not yield a worktree path.",
              threadId: null,
            });
          }
          yield* store.recordFallbackLaunch({
            launchId: attemptId,
            monitorId: monitor.id,
            commandId: commandIdValue,
            threadId: null,
            reason,
            status: "worktree-ready",
            error: null,
            createdAt: now,
          });

          const prompt = buildFallbackMaintenancePrompt({
            availableTools: monitorToolNamesForThread({
              instanceId: settings.textGenerationModelSelection.instanceId,
              providerInstances: settings.providerInstances,
            }),
            prNumber: monitor.number,
            repository: monitor.repository,
            url: snapshot.url,
            headBranch: snapshot.headBranch,
            headSha: snapshot.headSha,
            reason,
            previousOwnerThreadId: previousOwner,
            note: input.note ?? null,
            readinessSummary: formatBlockersSummary(readiness),
          });

          // Create the thread first (no turn). Claim exclusive ownership, then start
          // the maintenance turn so two modifiers can never race on the same PR.
          const createResult = yield* Effect.result(
            createFallbackThread({
              commandId,
              projectId: monitor.projectId,
              title: `PR maintenance ${monitor.repository}#${monitor.number}`,
              modelSelection: settings.textGenerationModelSelection,
              worktreePath: prCheckout.success.worktreePath,
              branch: prCheckout.success.branch,
              pullRequest: {
                number: monitor.number,
                title: snapshot.titleExcerpt || `${monitor.repository}#${monitor.number}`,
                url: snapshot.url,
                baseBranch: snapshot.baseBranch,
                headBranch: snapshot.headBranch,
              },
            }).pipe(Effect.provideService(OrchestrationEngineService, engine)),
          );

          if (Result.isFailure(createResult)) {
            const message =
              createResult.failure instanceof Error
                ? createResult.failure.message
                : String(createResult.failure);
            return yield* failLaunch({
              message: `Fallback thread create failed: ${message.slice(0, 300)}`,
              threadId: null,
              cause: createResult.failure,
            });
          }

          const fallbackThreadId = createResult.success.threadId;
          yield* store.recordFallbackLaunch({
            launchId: attemptId,
            monitorId: monitor.id,
            commandId: commandIdValue,
            threadId: fallbackThreadId,
            reason,
            status: "thread-created",
            error: null,
            createdAt: now,
          });
          const prepared = yield* waitForPreparedWorktree(fallbackThreadId);
          if (!prepared) {
            yield* abandonFallback({
              projectId: monitor.projectId,
              threadId: fallbackThreadId,
              commandIdPrefix: commandIdValue,
            });
            return yield* failLaunch({
              message:
                "Fallback worktree preparation did not complete; ownership was not transferred.",
              threadId: fallbackThreadId,
            });
          }

          const transferred = yield* store.transferOwnershipAtomic({
            monitorId: monitor.id,
            ownerThreadId: fallbackThreadId,
            expectedOwnerThreadId: previousOwner,
            updatedAt: now,
            eventId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
            toThreadId: fallbackThreadId,
            reason: `fallback:${reason}`,
          });
          if (!transferred) {
            yield* abandonFallback({
              projectId: monitor.projectId,
              threadId: fallbackThreadId,
              commandIdPrefix: commandIdValue,
            });
            return yield* failLaunch({
              message: "Ownership changed during fallback launch; abandoned prepared thread.",
              threadId: fallbackThreadId,
            });
          }

          yield* store.recordFallbackLaunch({
            launchId: attemptId,
            monitorId: monitor.id,
            commandId: commandIdValue,
            threadId: fallbackThreadId,
            reason,
            status: "owned",
            error: null,
            createdAt: now,
          });

          const turnResult = yield* Effect.result(
            startFallbackTurn({
              threadId: fallbackThreadId,
              commandId: CommandId.make(`${commandIdValue}:turn`),
              messageId,
              text: prompt,
              repository: monitor.repository,
              pullRequestNumber: monitor.number,
            }).pipe(Effect.provideService(OrchestrationEngineService, engine)),
          );
          if (Result.isFailure(turnResult)) {
            // Ownership already transferred; leave the thread for the operator and surface the error.
            const message =
              turnResult.failure instanceof Error
                ? turnResult.failure.message
                : String(turnResult.failure);
            yield* notify;
            return yield* failLaunch({
              message: `Fallback ownership transferred but turn start failed: ${message.slice(0, 300)}`,
              threadId: fallbackThreadId,
              cause: turnResult.failure,
            });
          }

          yield* store.recordFallbackLaunch({
            launchId: attemptId,
            monitorId: monitor.id,
            commandId: commandIdValue,
            threadId: fallbackThreadId,
            reason,
            status: "launched",
            error: null,
            createdAt: now,
          });
          yield* notify;

          return {
            monitor: {
              ...monitor,
              ownerThreadId: fallbackThreadId,
              updatedAt: now,
            },
            fallbackThreadId,
            previousOwnerThreadId: previousOwner,
            launched: true,
            skippedReason: null,
            commandId: commandIdValue,
          };
        }).pipe(Effect.ensuring(store.releaseLease(fallbackLease).pipe(Effect.orDie)));
      });

    yield* serverSettings.streamChanges.pipe(
      Stream.map((settings) =>
        JSON.stringify([
          settings.autoLaunchPrMonitorFallback,
          settings.copilotAutomaticPrFeedback,
          settings.textGenerationModelSelection.instanceId,
          Object.entries(settings.providerInstances).map(([id, instance]) => [id, instance.driver]),
        ]),
      ),
      Stream.changes,
      Stream.runForEach(() =>
        Effect.gen(function* () {
          let before: { updatedAt: string; monitorId: PullRequestMonitorId } | undefined;
          while (true) {
            const monitors = yield* store.listEnabledPage({
              limit: 100,
              ...(before ? { before } : {}),
            });
            for (const monitor of monitors) {
              const settings = yield* serverSettings.getSettings;
              if (!settings.autoLaunchPrMonitorFallback) return;
              if ((yield* ownerAvailability(monitor.ownerThreadId)).kind !== "unavailable")
                continue;
              if ((yield* feedback.listOpenItems(monitor.id)).length === 0) continue;
              if ((yield* automationBlockReason(monitor, settings)) !== null) continue;
              // Reuse fresh provider observation and the existing poll/takeover leases.
              yield* pollMonitor(monitor);
            }
            if (monitors.length < 100) break;
            const last = monitors[monitors.length - 1]!;
            before = { updatedAt: last.updatedAt, monitorId: last.id };
          }
          yield* notify;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("could not reconsider PR fallback after settings change", { cause }),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    return PullRequestMonitorService.of({
      start,
      stop,
      status,
      canDeliverAutomation,
      list,
      subscribeList: (input) =>
        Stream.concat(
          Stream.fromEffect(list(input)),
          Stream.fromPubSub(changes).pipe(Stream.mapEffect(() => list(input))),
        ),
      subscribeChanges: Stream.fromPubSub(changes),
      pollOnce,
      context,
      report,
      transferOwnership,
      submitFindings,
      launchFallback: (input) =>
        serverSettings.getSettings.pipe(
          Effect.mapError((cause) =>
            monitorError("Could not read settings for fallback launch.", { cause }),
          ),
          Effect.flatMap((settings) => launchFallback(input, settings)),
        ),
    });
  }),
);
