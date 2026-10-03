import {
  CommandId,
  MessageId,
  PullRequestMonitorError,
  type PullRequestMonitorActionableEvent,
  type PullRequestMonitorContextInput,
  type PullRequestMonitorContextResult,
  type PullRequestMonitorFeedbackDelivery,
  type PullRequestMonitorFeedbackDeliveryId,
  type PullRequestMonitorFeedbackActorRole,
  type PullRequestMonitorFeedbackItem,
  type PullRequestMonitorFeedbackItemId,
  type PullRequestMonitorFeedbackReport,
  type PullRequestMonitorFeedbackRevisionId,
  type PullRequestMonitorFinding,
  type PullRequestMonitorSubmittedFinding,
  type PullRequestMonitorId,
  type PullRequestMonitorRecord,
  type PullRequestMonitorReportInput,
  type PullRequestMonitorReportResult,
  type PullRequestMonitorSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { PullRequestMonitorStore } from "./PullRequestMonitorStore.ts";
import { PullRequestMonitorFeedbackStore } from "./PullRequestMonitorFeedbackStore.ts";
import {
  feedbackStableKeyOf,
  reconcileFeedbackItem,
  type FeedbackActionability,
} from "./feedbackReconciliation.ts";
import { type PullRequestMonitorFeedbackReadiness } from "./readiness.ts";
import { monitorToolNamesForThread } from "./monitorTools.ts";
import { sendQueuedTurn } from "./threadDelivery.ts";
import { buildWakePrompt } from "./wakePrompt.ts";
import {
  resolveFindingDetail,
  findingContextTurns,
  formatFindingDetail,
} from "./findingContext.ts";
import { buildMonitorAcceptanceProvenance } from "./acceptanceProvenance.ts";

/** Debounce window so CI/review bursts batch into one queued delivery. */
export const FEEDBACK_DEBOUNCE_MS = 15_000;
/** After this many consecutive delivery failures, open the circuit. */
export const DELIVERY_CIRCUIT_THRESHOLD = 5;
export const DELIVERY_CIRCUIT_COOLDOWN_MS = 15 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 8;
const QUEUED_DELIVERY_RETRY_MS = 20_000;

function isoNow() {
  return Effect.map(DateTime.now, (now) => DateTime.formatIso(DateTime.toUtc(now)));
}

function addMs(iso: string, ms: number): string {
  return DateTime.formatIso(
    DateTime.toUtc(DateTime.add(DateTime.makeUnsafe(iso), { milliseconds: ms })),
  );
}

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function stableHash(parts: ReadonlyArray<string>): string {
  return NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

function stableItemId(monitorId: string, stableKey: string): PullRequestMonitorFeedbackItemId {
  return `fb_item_${stableHash([monitorId, stableKey])}` as PullRequestMonitorFeedbackItemId;
}

/**
 * Identity is the observed source content, not an attempt counter: replaying the same
 * provider observation produces the same id, so ingestion is idempotent.
 */
function revisionContentHash(input: {
  readonly event: PullRequestMonitorActionableEvent;
  readonly summary: string;
}): string {
  return stableHash([
    input.event.kind,
    input.event.sourceId ?? "",
    input.event.detail ?? "",
    input.event.edited === true ? "1" : "0",
    input.summary,
  ]);
}

function stableRevisionId(
  itemId: string,
  sourceRevision: string,
  contentHash: string,
): PullRequestMonitorFeedbackRevisionId {
  return `fb_rev_${stableHash([itemId, sourceRevision, contentHash])}` as PullRequestMonitorFeedbackRevisionId;
}

/** `${kind}: ${detail}` — recover the detail (e.g. a check name) from a stored summary. */
export function feedbackDetailFromSummary(summary: string): string | null {
  const separator = summary.indexOf(": ");
  if (separator < 0) return null;
  const detail = summary.slice(separator + 2).trim();
  return detail.length === 0 ? null : detail;
}

function stableDeliveryIds(input: {
  readonly monitorId: string;
  readonly threadId: string;
  readonly revisionIds: ReadonlyArray<string>;
  readonly headSha: string;
}) {
  const batchKey = `fb_batch_${stableHash([input.monitorId, input.threadId, ...input.revisionIds, input.headSha])}`;
  const deliveryId = `fb_del_${stableHash([batchKey])}` as PullRequestMonitorFeedbackDeliveryId;
  const commandId = CommandId.make(`command:pr-monitor-feedback:${batchKey}`);
  const messageId = MessageId.make(`message:pr-monitor-feedback:${batchKey}`);
  return { batchKey, deliveryId, commandId, messageId };
}

function retargetDelivery(
  delivery: PullRequestMonitorFeedbackDelivery,
  ownerThreadId: ThreadId,
): PullRequestMonitorFeedbackDelivery {
  if (delivery.targetThreadId === ownerThreadId) return delivery;
  const ownerKey = stableHash([delivery.batchKey, ownerThreadId]);
  return {
    ...delivery,
    targetThreadId: ownerThreadId,
    commandId: CommandId.make(`command:pr-monitor-feedback:${delivery.batchKey}:owner:${ownerKey}`),
    messageId: MessageId.make(`message:pr-monitor-feedback:${delivery.batchKey}:owner:${ownerKey}`),
  };
}

function eventSummary(event: PullRequestMonitorActionableEvent): string {
  const detail = event.detail ?? event.sourceId ?? event.kind;
  return `${event.kind}: ${detail}`.slice(0, 500);
}

function monitorError(message: string, cause?: unknown) {
  return new PullRequestMonitorError({ message, cause });
}

export class PullRequestMonitorFeedbackService extends Context.Service<
  PullRequestMonitorFeedbackService,
  {
    /**
     * Reconcile durable findings against fresh provider state, then ingest new events.
     * Runs inside the poll transaction so the cursor and the feedback ledger commit together.
     */
    readonly reconcileAndIngest: (input: {
      readonly monitor: PullRequestMonitorRecord;
      readonly snapshot: PullRequestMonitorSnapshot;
      readonly events: ReadonlyArray<PullRequestMonitorActionableEvent>;
    }) => Effect.Effect<PullRequestMonitorFeedbackReadiness, PullRequestMonitorError>;
    readonly readinessSummary: (
      monitorId: PullRequestMonitorId,
    ) => Effect.Effect<PullRequestMonitorFeedbackReadiness, PullRequestMonitorError>;
    /**
     * Ingest reviewer-submitted findings as durable feedback items. Each finding gets its own
     * id and revision so it can be delivered, dispositioned, and audited individually.
     */
    readonly ingestFindings: (input: {
      readonly monitor: PullRequestMonitorRecord;
      readonly reviewThreadId: ThreadId;
      readonly findings: ReadonlyArray<PullRequestMonitorFinding>;
      readonly reviewedHeadSha?: string;
      readonly origin?: "provider" | "reviewer";
    }) => Effect.Effect<ReadonlyArray<PullRequestMonitorSubmittedFinding>, PullRequestMonitorError>;
    readonly flushDueDeliveries: Effect.Effect<void>;
    /**
     * Return a delivery to the durable retry loop after its queued turn could not be safely
     * dispatched. Callers may delete the queue entry only after this succeeds.
     */
    readonly retryQueuedDelivery: (input: {
      readonly deliveryId: PullRequestMonitorFeedbackDeliveryId;
      readonly reason: string;
    }) => Effect.Effect<void, PullRequestMonitorError>;
    readonly context: (
      input: PullRequestMonitorContextInput & {
        readonly resolveMonitor: () => Effect.Effect<
          PullRequestMonitorRecord | null,
          PullRequestMonitorError
        >;
      },
    ) => Effect.Effect<PullRequestMonitorContextResult, PullRequestMonitorError>;
    readonly report: (
      input: PullRequestMonitorReportInput & {
        readonly resolveMonitor: () => Effect.Effect<
          PullRequestMonitorRecord,
          PullRequestMonitorError
        >;
        readonly requestRecheck: (
          monitor: PullRequestMonitorRecord,
        ) => Effect.Effect<void, PullRequestMonitorError>;
      },
    ) => Effect.Effect<PullRequestMonitorReportResult, PullRequestMonitorError>;
    readonly listOpenItems: (
      monitorId: PullRequestMonitorId,
    ) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackItem>, PullRequestMonitorError>;
    readonly listDeliveries: (
      monitorId: PullRequestMonitorId,
    ) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackDelivery>, PullRequestMonitorError>;
    readonly listReports: (
      monitorId: PullRequestMonitorId,
    ) => Effect.Effect<ReadonlyArray<PullRequestMonitorFeedbackReport>, PullRequestMonitorError>;
  }
>()("t3/pullRequestMonitor/PullRequestMonitorFeedbackService") {}

export const layer = Layer.effect(
  PullRequestMonitorFeedbackService,
  Effect.gen(function* () {
    const feedbackStore = yield* PullRequestMonitorFeedbackStore.make;
    const monitorStore = yield* PullRequestMonitorStore.make;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const serverSettings = yield* ServerSettingsService;

    /** Tools the delivery target can actually call; never advertise anything else. */
    const availableToolsFor = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const shell = yield* Effect.result(projections.getThreadShellById(threadId));
        if (Result.isFailure(shell) || Option.isNone(shell.success)) return [];
        const settings = yield* Effect.result(serverSettings.getSettings);
        return monitorToolNamesForThread({
          instanceId: shell.success.value.modelSelection.instanceId,
          ...(Result.isSuccess(settings)
            ? { providerInstances: settings.success.providerInstances }
            : {}),
        });
      });

    const listOpenItems = (monitorId: PullRequestMonitorId) =>
      feedbackStore.listItems({ monitorId, includeClosed: false });
    const listDeliveries = (monitorId: PullRequestMonitorId) =>
      feedbackStore.listDeliveries({ monitorId, limit: 20 });
    const listReports = (monitorId: PullRequestMonitorId) =>
      feedbackStore.listReports({ monitorId, limit: 20 });

    /** Close a finding on provider evidence, with a durable audit row. */
    const closeItemUpstream = (input: {
      readonly item: PullRequestMonitorFeedbackItem;
      readonly actionability: Exclude<FeedbackActionability, { kind: "actionable" }>;
      readonly now: string;
    }) =>
      Effect.gen(function* () {
        yield* feedbackStore.reportDisposition({
          itemId: input.item.id,
          disposition: input.actionability.kind,
          note: input.actionability.detail,
          at: input.now,
          byThreadId: null,
          status: "closed",
          report: {
            id: `fb_report_${stableHash([input.item.monitorId, input.item.id, input.actionability.kind, input.now])}`,
            monitorId: input.item.monitorId,
            itemId: input.item.id,
            disposition: input.actionability.kind,
            note: input.actionability.detail,
            reporterThreadId: null,
            createdAt: input.now,
          },
        });
      });

    const summarize = (
      monitorId: PullRequestMonitorId,
    ): Effect.Effect<PullRequestMonitorFeedbackReadiness, PullRequestMonitorError> =>
      Effect.gen(function* () {
        const items = yield* feedbackStore.listItems({ monitorId, includeClosed: false });
        const deliveries = yield* feedbackStore.listDeliveries({ monitorId, limit: 50 });
        let openCount = 0;
        let verifyingCount = 0;
        let needsHumanCount = 0;
        for (const item of items) {
          if (item.status === "verifying") verifyingCount += 1;
          else if (item.disposition === "needs-human" || item.reviewerDisposition === "needs-human")
            needsHumanCount += 1;
          else openCount += 1;
        }
        return {
          openCount,
          verifyingCount,
          needsHumanCount,
          pendingDeliveryCount: deliveries.filter(
            (delivery) => delivery.status === "pending" || delivery.status === "failed",
          ).length,
        } satisfies PullRequestMonitorFeedbackReadiness;
      });

    /**
     * Fresh reconciliation of every durable finding. Provider evidence is the only thing that
     * closes a finding; an agent's `resolved` claim only parks it in `verifying` until a
     * later snapshot proves it. Incomplete provider evidence keeps a finding open.
     */
    const reconcileOpenItems = (input: {
      readonly monitor: PullRequestMonitorRecord;
      readonly snapshot: PullRequestMonitorSnapshot;
      readonly now: string;
    }) =>
      Effect.gen(function* () {
        const items = yield* feedbackStore.listItems({
          monitorId: input.monitor.id,
          includeClosed: false,
        });
        const closedRevisionIds: string[] = [];
        for (const item of items) {
          const actionability = reconcileFeedbackItem(item, input.snapshot, {
            checkName: feedbackDetailFromSummary(item.summary),
            observedHeadSha: item.currentRevisionHeadSha,
            claimHeadSha: item.status === "verifying" ? item.currentRevisionHeadSha : null,
          });
          if (actionability.kind === "actionable") {
            if (item.status === "verifying") {
              // The claim was not confirmed by the provider: the finding is live again.
              yield* feedbackStore.setDisposition({
                itemId: item.id,
                disposition: "accepted",
                note: "Claimed resolved, but the finding is still reported upstream.",
                at: input.now,
                byThreadId: item.dispositionByThreadId,
                status: "open",
              });
            }
            continue;
          }
          yield* closeItemUpstream({ item, actionability, now: input.now });
          if (item.currentRevisionId) closedRevisionIds.push(item.currentRevisionId);
        }
        if (closedRevisionIds.length > 0) {
          yield* feedbackStore.removePendingRevisionIds({
            monitorId: input.monitor.id,
            revisionIds: closedRevisionIds,
            updatedAt: input.now,
          });
        }
      });

    const ingestFindings: (typeof PullRequestMonitorFeedbackService.Service)["ingestFindings"] = (
      input,
    ) =>
      Effect.gen(function* () {
        if (input.findings.length === 0) return [];
        const now = yield* isoNow();
        const headSha = input.reviewedHeadSha ?? input.monitor.headSha ?? "unknown";
        // Findings are scoped to the head they were reviewed against, so a re-review after a
        // push records a new revision instead of colliding with the previous one.
        const defaultSourceRevision = `review:${headSha}`;
        const submitted: PullRequestMonitorSubmittedFinding[] = [];
        const newRevisionIds: string[] = [];

        for (const finding of input.findings) {
          const acceptanceInput = finding.acceptanceProvenance;
          if (acceptanceInput !== undefined && acceptanceInput.headSha !== headSha) {
            return yield* monitorError(
              "Acceptance provenance head does not match the reviewed finding head.",
              {
                cause: {
                  reviewedHeadSha: headSha,
                  provenanceHeadSha: acceptanceInput.headSha,
                },
              },
            );
          }
          const key =
            finding.key ??
            stableHash([finding.title, finding.path ?? "", String(finding.line ?? 0)]);
          const stableKey = `review-finding:${key}`;
          const itemId = stableItemId(input.monitor.id, stableKey);
          const location =
            finding.path === undefined
              ? ""
              : ` (${finding.path}${finding.line === undefined ? "" : `:${finding.line}`})`;
          const summary = `review-finding: [${finding.severity}] ${finding.title}${location}`.slice(
            0,
            500,
          );
          const existing = yield* feedbackStore.getItem(itemId);
          const origin = input.origin ?? "reviewer";
          const closedByExplicitAgreement =
            existing?.status === "closed" &&
            (existing.disposition === "withdrawn" ||
              existing.disposition === "rejected-with-reviewer-agreement");
          yield* feedbackStore.upsertOpenItem({
            item: {
              id: itemId,
              monitorId: input.monitor.id,
              stableKey,
              kind: "review-finding",
              status: closedByExplicitAgreement ? "closed" : "open",
              disposition: closedByExplicitAgreement ? (existing?.disposition ?? null) : null,
              dispositionNote: closedByExplicitAgreement
                ? (existing?.dispositionNote ?? null)
                : null,
              dispositionAt: closedByExplicitAgreement ? (existing?.dispositionAt ?? null) : null,
              dispositionByThreadId: closedByExplicitAgreement
                ? (existing?.dispositionByThreadId ?? null)
                : null,
              firstSeenAt: existing?.firstSeenAt ?? now,
              lastSeenAt: now,
              currentRevisionId: null,
              summary,
              origin,
              originThreadId: input.reviewThreadId,
              childDisposition: existing?.childDisposition ?? null,
              reviewerDisposition: existing?.reviewerDisposition ?? null,
            },
          });

          const event = {
            kind: "review-finding" as const,
            sourceId: key,
            detail: `[${finding.severity}] ${finding.title}${location}`.slice(0, 500),
          };
          const contentHash = stableHash([
            key,
            finding.title,
            finding.detail,
            finding.severity,
            finding.path ?? "",
            String(finding.line ?? 0),
            ...(acceptanceInput === undefined ? [] : [JSON.stringify(acceptanceInput)]),
            ...(finding.provenance === undefined
              ? []
              : [
                  finding.provenance.reviewedHeadSha,
                  finding.provenance.diffHash,
                  finding.provenance.path,
                  finding.provenance.side,
                  String(finding.provenance.startLine),
                  String(finding.provenance.endLine),
                ]),
          ]);
          const sourceRevision = acceptanceInput?.sourceRevision ?? defaultSourceRevision;
          const revisionId = stableRevisionId(itemId, sourceRevision, contentHash);
          const acceptanceProvenance =
            acceptanceInput === undefined
              ? undefined
              : buildMonitorAcceptanceProvenance({
                  monitorId: input.monitor.id,
                  findingId: itemId,
                  findingRevisionId: revisionId,
                  provenance: acceptanceInput,
                });
          const inserted = yield* feedbackStore.insertRevision({
            id: revisionId,
            itemId,
            revisionNumber: yield* feedbackStore.nextRevisionNumber(itemId),
            sourceRevision,
            contentHash,
            headSha,
            createdAt: now,
            summary,
            payload: {
              event,
              finding,
              reviewThreadId: input.reviewThreadId,
              origin,
              reviewedHeadSha: headSha,
              ...(acceptanceProvenance === undefined ? {} : { acceptanceProvenance }),
              contentVersion: 1,
            },
          });
          if (inserted) newRevisionIds.push(revisionId);
          submitted.push({ key, itemId, revisionId, created: inserted });
        }

        if (newRevisionIds.length > 0) {
          yield* feedbackStore.appendPendingRevisionIds({
            monitorId: input.monitor.id,
            revisionIds: newRevisionIds,
            debounceUntil: addMs(now, FEEDBACK_DEBOUNCE_MS),
            updatedAt: now,
          });
        }
        return submitted;
      });

    const reconcileAndIngest: (typeof PullRequestMonitorFeedbackService.Service)["reconcileAndIngest"] =
      (input) =>
        Effect.gen(function* () {
          const now = yield* isoNow();
          if (input.snapshot.state !== "open") {
            // A closed/merged PR has no remediation work; readiness handles the terminal state.
            return yield* summarize(input.monitor.id);
          }

          yield* reconcileOpenItems({
            monitor: input.monitor,
            snapshot: input.snapshot,
            now,
          });

          const newRevisionIds: string[] = [];
          for (const event of input.events) {
            // Terminal state changes are not remediation work.
            if (event.kind === "state-changed") continue;

            const stableKey = feedbackStableKeyOf(event);
            const itemId = stableItemId(input.monitor.id, stableKey);
            const existing = yield* feedbackStore.getItem(itemId);
            const summary = eventSummary(event);

            if (!existing) {
              yield* feedbackStore.upsertOpenItem({
                item: {
                  id: itemId,
                  monitorId: input.monitor.id,
                  stableKey,
                  kind: event.kind,
                  status: "open",
                  disposition: null,
                  dispositionNote: null,
                  dispositionAt: null,
                  dispositionByThreadId: null,
                  firstSeenAt: now,
                  lastSeenAt: now,
                  currentRevisionId: null,
                  summary,
                },
              });
            } else if (
              existing.status === "closed" &&
              (existing.disposition === "resolved" ||
                existing.disposition === "resolved-upstream" ||
                existing.disposition === "superseded")
            ) {
              // Re-open only when the same finding resurfaces after it was resolved.
              yield* feedbackStore.upsertOpenItem({
                item: {
                  ...existing,
                  status: "open",
                  disposition: null,
                  dispositionNote: null,
                  dispositionAt: null,
                  dispositionByThreadId: null,
                  lastSeenAt: now,
                  summary,
                },
              });
            } else if (
              existing.disposition === "rejected" ||
              existing.disposition === "needs-human"
            ) {
              // Human/agent already classified; do not re-wake on the same stable key.
              continue;
            } else {
              yield* feedbackStore.upsertOpenItem({
                item: {
                  ...existing,
                  status: existing.status === "verifying" ? "open" : existing.status,
                  lastSeenAt: now,
                  summary,
                },
              });
            }

            const contentHash = revisionContentHash({ event, summary });
            const revisionId = stableRevisionId(itemId, input.snapshot.sourceRevision, contentHash);
            const inserted = yield* feedbackStore.insertRevision({
              id: revisionId,
              itemId,
              revisionNumber: yield* feedbackStore.nextRevisionNumber(itemId),
              sourceRevision: input.snapshot.sourceRevision,
              contentHash,
              headSha: input.snapshot.headSha,
              createdAt: now,
              summary,
              payload: {
                event,
                // Bound excerpts only in durable payload; full bodies stay on the provider.
                titleExcerpt: input.snapshot.titleExcerpt,
                url: input.snapshot.url,
              },
            });
            // A replayed observation is already queued or delivered; never queue it twice.
            if (inserted) newRevisionIds.push(revisionId);
          }

          if (newRevisionIds.length > 0) {
            yield* feedbackStore.appendPendingRevisionIds({
              monitorId: input.monitor.id,
              revisionIds: newRevisionIds,
              debounceUntil: addMs(now, FEEDBACK_DEBOUNCE_MS),
              updatedAt: now,
            });
          }

          return yield* summarize(input.monitor.id);
        });

    const revalidateForDelivery = (monitor: PullRequestMonitorRecord) =>
      Effect.gen(function* () {
        if (monitor.status === "terminal") {
          return yield* monitorError("Pull request is no longer open.");
        }
        if (!monitor.ownerThreadId) {
          return yield* monitorError("Monitor has no owner thread for delivery.");
        }

        const snapshotResult = yield* Effect.result(
          pullRequests.monitorSnapshot({
            projectId: monitor.projectId,
            repository: monitor.repository,
            number: monitor.number,
          }),
        );
        if (Result.isFailure(snapshotResult)) {
          return yield* monitorError(
            "Fresh monitor snapshot failed before delivery.",
            snapshotResult.failure,
          );
        }
        const snapshot = snapshotResult.success;
        if (snapshot.state !== "open") {
          return yield* monitorError("Pull request is no longer open.");
        }
        return { snapshot, ownerThreadId: monitor.ownerThreadId as ThreadId };
      });

    const deliverOne = (delivery: PullRequestMonitorFeedbackDelivery) =>
      Effect.gen(function* () {
        const now = yield* isoNow();
        const monitor = yield* monitorStore.getById(delivery.monitorId);
        if (!monitor) {
          yield* feedbackStore.updateDelivery({
            ...delivery,
            status: "suppressed",
            lastError: "Monitor missing",
            nextAttemptAt: null,
            deliveredAt: null,
            receiptJson: null,
          });
          return;
        }

        const state = yield* feedbackStore.getState(monitor.id);
        if (state.circuitOpenUntil && state.circuitOpenUntil > now) {
          yield* feedbackStore.updateDelivery({
            ...delivery,
            status: "failed",
            attemptCount: delivery.attemptCount,
            lastError: "Circuit open",
            nextAttemptAt: state.circuitOpenUntil,
            deliveredAt: null,
            receiptJson: null,
          });
          return;
        }

        const validated = yield* Effect.result(revalidateForDelivery(monitor));
        if (Result.isFailure(validated)) {
          const attemptCount = delivery.attemptCount + 1;
          const message =
            validated.failure instanceof Error
              ? validated.failure.message
              : String(validated.failure);
          const suppressedByRevalidation = /no longer open/i.test(message);
          const terminal = suppressedByRevalidation || attemptCount >= MAX_DELIVERY_ATTEMPTS;
          if (suppressedByRevalidation) {
            yield* feedbackStore.setDeliveryCircuitState({
              monitorId: state.monitorId,
              deliveryFailureCount: 0,
              circuitOpenUntil: null,
              updatedAt: now,
            });
          } else {
            const failureCount = state.deliveryFailureCount + 1;
            const circuitOpenUntil =
              failureCount >= DELIVERY_CIRCUIT_THRESHOLD
                ? addMs(now, DELIVERY_CIRCUIT_COOLDOWN_MS)
                : state.circuitOpenUntil;
            yield* feedbackStore.setDeliveryCircuitState({
              monitorId: state.monitorId,
              deliveryFailureCount: failureCount,
              circuitOpenUntil,
              updatedAt: now,
            });
          }
          yield* feedbackStore.updateDelivery({
            ...delivery,
            status: terminal ? "suppressed" : "failed",
            attemptCount,
            lastError: message.slice(0, 1000),
            nextAttemptAt: terminal
              ? null
              : addMs(now, Math.min(60_000 * 2 ** Math.min(attemptCount, 5), 30 * 60_000)),
            deliveredAt: null,
            receiptJson: null,
          });
          return;
        }

        const { snapshot, ownerThreadId } = validated.success;
        const readiness = monitor.readiness ?? {
          ready: false,
          label: "blocked" as const,
          blockers: [{ kind: "checks-missing" as const }],
        };

        // Fresh per-finding reconciliation: never wake an owner about work the provider
        // already resolved, and never let a stale batch resurrect a closed finding.
        const batchRevisions = yield* feedbackStore.listRevisionsByIds(delivery.revisionIds);
        const revisions: Array<(typeof batchRevisions)[number]> = [];
        for (const revision of batchRevisions) {
          const item = yield* feedbackStore.getItem(revision.itemId);
          if (!item || item.status === "closed") continue;
          // A historical delivery must not mutate or deliver a newer item revision.
          if (item.currentRevisionId !== revision.id) continue;
          const actionability = reconcileFeedbackItem(item, snapshot, {
            checkName: feedbackDetailFromSummary(item.summary),
            observedHeadSha: revision.headSha,
          });
          if (actionability.kind !== "actionable") {
            yield* closeItemUpstream({ item, actionability, now });
            continue;
          }
          revisions.push(revision);
        }

        if (revisions.length === 0) {
          yield* feedbackStore.updateDelivery({
            ...delivery,
            status: "suppressed",
            attemptCount: delivery.attemptCount + 1,
            lastError: "All findings in this batch were resolved upstream before delivery.",
            nextAttemptAt: null,
            deliveredAt: null,
            receiptJson: null,
          });
          yield* feedbackStore.setDeliveryCircuitState({
            monitorId: state.monitorId,
            deliveryFailureCount: 0,
            circuitOpenUntil: null,
            updatedAt: now,
          });
          return;
        }

        // A delivered batch can be retried after its owner changes. Use a new command
        // identity for the new recipient so the old thread's receipt cannot swallow it.
        const targetedDelivery = retargetDelivery(delivery, ownerThreadId);
        if (targetedDelivery !== delivery) {
          yield* feedbackStore.updateDelivery({
            ...targetedDelivery,
            nextAttemptAt: now,
            receiptJson: null,
          });
        }

        // Bounded events reconstructed from durable revision payloads.
        const events: Array<PullRequestMonitorActionableEvent> = [];
        const eventsByRevision = new Map<
          PullRequestMonitorFeedbackRevisionId,
          PullRequestMonitorActionableEvent
        >();
        const revisionSummaries: string[] = [];
        for (const revision of revisions) {
          revisionSummaries.push(revision.summary);
          const payload = revision.payload;
          if (
            payload &&
            typeof payload === "object" &&
            "event" in payload &&
            payload.event &&
            typeof payload.event === "object" &&
            "kind" in payload.event &&
            typeof (payload.event as { kind: unknown }).kind === "string"
          ) {
            events.push(payload.event as PullRequestMonitorActionableEvent);
            eventsByRevision.set(revision.id, payload.event as PullRequestMonitorActionableEvent);
          }
        }

        const availableTools = yield* availableToolsFor(ownerThreadId);
        const canRetrieve = availableTools.includes("pr_monitor_context");
        const findingText = (entries: typeof batchRevisions) =>
          entries
            .filter((revision) => revision.summary.startsWith("review-finding:"))
            .map((revision) => formatFindingDetail(resolveFindingDetail(revision)))
            .join("\n\n");
        // Choose the layout from the immutable batch, so partial retries never renumber parts.
        const inlineBatch = findingText(batchRevisions).length <= 12_000;
        const parts: ReadonlyArray<{
          key: string;
          text: string;
          revisionId?: PullRequestMonitorFeedbackRevisionId;
        }> = inlineBatch
          ? [{ key: "", text: findingText(revisions) }]
          : canRetrieve
            ? [
                {
                  key: "",
                  text: `${revisions.length} delivered revisions:\n${revisions
                    .slice(0, 20)
                    .map(
                      (revision) => `${revision.id} (item ${revision.itemId}): ${revision.summary}`,
                    )
                    .join(
                      "\n",
                    )}${revisions.length > 20 ? "\nMore revisions: retrieve this delivery and follow nextOffset." : ""}`,
                },
              ]
            : findingContextTurns(revisions);
        const promptInput = {
          prNumber: monitor.number,
          repository: monitor.repository,
          deliveryId: delivery.id,
          events,
          revisionSummaries,
          snapshot,
          readiness,
          availableTools,
        };

        // Durable queue behind any active turn; QueuedTurnReactor drains it when idle.
        const sendResult = yield* Effect.result(
          Effect.forEach(
            parts,
            (part) => {
              const findingContext = part.text.length === 0 ? undefined : part.text;
              const suffix = part.key.length === 0 ? "" : `:${part.key}`;
              const revisionEvent =
                part.revisionId === undefined ? undefined : eventsByRevision.get(part.revisionId);
              const turnEvents =
                part.revisionId === undefined
                  ? events
                  : revisionEvent === undefined
                    ? []
                    : [revisionEvent];
              const turnSummaries =
                part.revisionId === undefined
                  ? revisionSummaries
                  : revisions
                      .filter((revision) => revision.id === part.revisionId)
                      .map((revision) => revision.summary);
              return sendQueuedTurn({
                threadId: ownerThreadId,
                commandId: CommandId.make(`${targetedDelivery.commandId}${suffix}`),
                messageId: MessageId.make(`${targetedDelivery.messageId}${suffix}`),
                text: buildWakePrompt({
                  ...promptInput,
                  events: turnEvents,
                  revisionSummaries: turnSummaries,
                  ...(findingContext === undefined ? {} : { findingContext }),
                }),
                ...(findingContext === undefined ? {} : { findingContext }),
                repository: monitor.repository,
                pullRequestNumber: monitor.number,
                headSha: snapshot.headSha,
                sourceRevision: snapshot.sourceRevision,
                events: turnEvents,
                deliveryId: delivery.id,
                revisionSummaries: turnSummaries,
                availableTools,
              });
            },
            { concurrency: 1 },
          ).pipe(Effect.provideService(OrchestrationEngineService, engine)),
        );

        if (Result.isFailure(sendResult)) {
          const attemptCount = delivery.attemptCount + 1;
          const message =
            sendResult.failure instanceof Error
              ? sendResult.failure.message
              : String(sendResult.failure);
          const failureCount = state.deliveryFailureCount + 1;
          const circuitOpenUntil =
            failureCount >= DELIVERY_CIRCUIT_THRESHOLD
              ? addMs(now, DELIVERY_CIRCUIT_COOLDOWN_MS)
              : state.circuitOpenUntil;
          yield* feedbackStore.setDeliveryCircuitState({
            monitorId: state.monitorId,
            deliveryFailureCount: failureCount,
            circuitOpenUntil,
            updatedAt: now,
          });
          yield* feedbackStore.updateDelivery({
            ...targetedDelivery,
            status: attemptCount >= MAX_DELIVERY_ATTEMPTS ? "suppressed" : "failed",
            attemptCount,
            lastError: message.slice(0, 1000),
            nextAttemptAt:
              attemptCount >= MAX_DELIVERY_ATTEMPTS
                ? null
                : addMs(now, Math.min(60_000 * 2 ** Math.min(attemptCount, 5), 30 * 60_000)),
            deliveredAt: null,
            receiptJson: null,
          });
          return;
        }

        yield* feedbackStore.updateDelivery({
          ...targetedDelivery,
          status: "delivered",
          attemptCount: delivery.attemptCount + 1,
          lastError: null,
          nextAttemptAt: null,
          deliveredAt: now,
          receiptJson: encodeUnknownJson({
            deliveryId: targetedDelivery.id,
            commandId: targetedDelivery.commandId,
            messageId: targetedDelivery.messageId,
            deliveredVia: "thread.queued-turn.create",
          }),
        });
        yield* feedbackStore.setDeliveryCircuitState({
          monitorId: state.monitorId,
          deliveryFailureCount: 0,
          circuitOpenUntil: null,
          updatedAt: now,
        });
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Feedback delivery failed", { cause })),
      );

    const materializePendingBatches = Effect.gen(function* () {
      const now = yield* isoNow();
      let before: { updatedAt: string; monitorId: PullRequestMonitorId } | undefined;
      while (true) {
        const pendingMonitors = yield* monitorStore.listPendingFeedbackPage({
          limit: 500,
          ...(before ? { before } : {}),
        });
        for (const pendingMonitor of pendingMonitors) {
          const { monitor } = pendingMonitor;
          if (!monitor.ownerThreadId) continue;
          const state = yield* feedbackStore.getState(monitor.id);
          if (state.pendingRevisionIds.length === 0) continue;
          if (state.debounceUntil && state.debounceUntil > now) continue;
          if (state.circuitOpenUntil && state.circuitOpenUntil > now) continue;

          const revisionIds = [...state.pendingRevisionIds].sort();
          const ids = stableDeliveryIds({
            monitorId: monitor.id,
            threadId: monitor.ownerThreadId,
            revisionIds,
            headSha: monitor.headSha ?? "unknown",
          });

          const existing = yield* feedbackStore.getDeliveryByBatchKey(ids.batchKey);
          if (!existing) {
            const delivery: PullRequestMonitorFeedbackDelivery = {
              id: ids.deliveryId,
              monitorId: monitor.id,
              batchKey: ids.batchKey,
              targetThreadId: monitor.ownerThreadId,
              commandId: ids.commandId,
              messageId: ids.messageId,
              revisionIds:
                revisionIds as unknown as ReadonlyArray<PullRequestMonitorFeedbackRevisionId>,
              status: "pending",
              attemptCount: 0,
              lastError: null,
              createdAt: now,
              deliveredAt: null,
            };
            yield* feedbackStore.insertDelivery({
              ...delivery,
              nextAttemptAt: now,
              receiptJson: null,
            });
          }

          yield* feedbackStore.removePendingRevisionIds({
            monitorId: monitor.id,
            revisionIds,
            updatedAt: now,
          });
        }

        if (pendingMonitors.length < 500) break;
        const last = pendingMonitors[pendingMonitors.length - 1];
        if (!last) break;
        before = { updatedAt: last.updatedAt, monitorId: last.monitor.id };
      }
    }).pipe(Effect.ignore);

    const flushDueDeliveries = materializePendingBatches.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const now = yield* isoNow();
          const due = yield* feedbackStore.listDueDeliveries(now, 16);
          // Group by monitor so circuit/order updates cannot race within one monitor.
          const byMonitor = new Map<string, Array<(typeof due)[number]>>();
          for (const delivery of due) {
            const group = byMonitor.get(delivery.monitorId) ?? [];
            group.push(delivery);
            byMonitor.set(delivery.monitorId, group);
          }
          yield* Effect.forEach(
            [...byMonitor.values()],
            (group) => Effect.forEach(group, deliverOne, { concurrency: 1 }),
            { concurrency: 2 },
          );
        }),
      ),
      Effect.ignore,
    );

    const retryQueuedDelivery: (typeof PullRequestMonitorFeedbackService.Service)["retryQueuedDelivery"] =
      (input) =>
        Effect.gen(function* () {
          const delivery = yield* feedbackStore.getDelivery(input.deliveryId);
          if (!delivery) {
            return yield* monitorError(`Feedback delivery '${input.deliveryId}' was not found.`);
          }
          if (delivery.status === "failed" || delivery.status === "suppressed") return;
          const now = yield* isoNow();
          yield* feedbackStore.updateDelivery({
            ...delivery,
            status: "failed",
            lastError: input.reason.slice(0, 1_000),
            nextAttemptAt: addMs(now, QUEUED_DELIVERY_RETRY_MS),
            deliveredAt: null,
            receiptJson: null,
          });
        });

    // Background flusher for debounce maturity + retries.
    yield* flushDueDeliveries.pipe(
      Effect.andThen(Effect.sleep(Duration.seconds(5))),
      Effect.forever,
      Effect.forkScoped,
      Effect.interruptible,
    );
    yield* Stream.fromSchedule(Schedule.spaced(Duration.seconds(20))).pipe(
      Stream.mapEffect(() => flushDueDeliveries),
      Stream.runDrain,
      Effect.forkScoped,
      Effect.interruptible,
    );

    const context: (typeof PullRequestMonitorFeedbackService.Service)["context"] = (input) =>
      Effect.gen(function* () {
        const monitor = yield* input.resolveMonitor();
        if (!monitor) {
          if (input.deliveryId !== undefined || input.revisionIds !== undefined) {
            return yield* monitorError("No pull request monitor matched this context request.");
          }
          return {
            monitor: null,
            latestSnapshot: null,
            items: [],
            recentDeliveries: [],
            recentReports: [],
            revisions: [],
            findingDetails: [],
            nextOffset: null,
          };
        }
        const latest = yield* monitorStore.latestSnapshot(monitor.id);
        const items = yield* feedbackStore.listItems({
          monitorId: monitor.id,
          includeClosed:
            input.includeClosed === true ||
            input.deliveryId !== undefined ||
            input.revisionIds !== undefined,
        });
        const recentDeliveries = yield* listDeliveries(monitor.id);
        const recentReports = yield* listReports(monitor.id);
        if (input.deliveryId !== undefined && input.revisionIds !== undefined) {
          return yield* monitorError("Select a delivery or revisions, not both.");
        }
        const delivery =
          input.deliveryId === undefined
            ? null
            : yield* feedbackStore.getDelivery(input.deliveryId);
        if (input.deliveryId !== undefined && (!delivery || delivery.monitorId !== monitor.id)) {
          return yield* monitorError("Delivery was not found on this monitor.");
        }
        const selectedIds =
          delivery?.revisionIds ??
          input.revisionIds ??
          items.flatMap((item) =>
            item.currentRevisionId === null ? [] : [item.currentRevisionId],
          );
        const orderedIds = [...new Set(selectedIds)];
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 10;
        const pageIds = orderedIds.slice(offset, offset + limit);
        const idsToValidate = input.revisionIds === undefined ? pageIds : orderedIds;
        const selected = yield* feedbackStore.listRevisionsByIds(idsToValidate);
        if (selected.length !== idsToValidate.length) {
          return yield* monitorError("One or more feedback revisions are unavailable.");
        }
        const itemsById = new Map(items.map((item) => [item.id, item]));
        for (const revision of selected) {
          const item = itemsById.get(revision.itemId);
          if (!item || item.monitorId !== monitor.id) {
            return yield* monitorError("Revision was not found on this monitor.");
          }
        }
        const byId = new Map(selected.map((revision) => [revision.id, revision]));
        const page = pageIds.flatMap((id) => {
          const revision = byId.get(id);
          return revision ? [revision] : [];
        });
        return {
          monitor,
          latestSnapshot: latest?.snapshot ?? null,
          items,
          recentDeliveries,
          recentReports,
          revisions: page,
          findingDetails: page
            .filter((revision) => revision.summary.startsWith("review-finding:"))
            .map(resolveFindingDetail),
          nextOffset: offset + limit < orderedIds.length ? offset + limit : null,
        };
      });

    const report: (typeof PullRequestMonitorFeedbackService.Service)["report"] = (input) =>
      Effect.gen(function* () {
        const monitor = yield* input.resolveMonitor();
        const item = yield* feedbackStore.getItem(input.itemId);
        if (!item || item.monitorId !== monitor.id) {
          return yield* monitorError("Feedback item was not found on this monitor.");
        }
        const now = yield* isoNow();
        const reviewerReport =
          input.reporterThreadId !== null &&
          input.reporterThreadId !== undefined &&
          item.origin === "reviewer" &&
          item.originThreadId === input.reporterThreadId;
        let actorRole: PullRequestMonitorFeedbackActorRole;
        let status: PullRequestMonitorFeedbackItem["status"];
        let storedDisposition: PullRequestMonitorFeedbackItem["disposition"];
        let childDisposition = item.childDisposition ?? null;
        let reviewerDisposition = item.reviewerDisposition ?? null;

        if (reviewerReport) {
          if (
            input.disposition !== "withdrawn" &&
            input.disposition !== "revised" &&
            input.disposition !== "upheld" &&
            input.disposition !== "needs-human"
          ) {
            return yield* monitorError(
              "Reviewer findings accept only withdrawn, revised, upheld, or needs-human outcomes.",
            );
          }
          actorRole = "reviewer";
          reviewerDisposition = input.disposition;
          if (input.disposition === "withdrawn") {
            const agreedRejection = childDisposition === "rejected";
            storedDisposition = agreedRejection ? "rejected-with-reviewer-agreement" : "withdrawn";
            status = "closed";
          } else {
            storedDisposition = input.disposition;
            status = "open";
          }
        } else {
          if (
            input.disposition !== "accepted" &&
            input.disposition !== "resolved" &&
            input.disposition !== "rejected" &&
            input.disposition !== "needs-human"
          ) {
            return yield* monitorError(
              "Child findings accept only accepted, resolved, rejected, or needs-human outcomes.",
            );
          }
          actorRole = "child";
          childDisposition = input.disposition;
          // A child rejection is a live dispute, not closure. Only a reviewer withdrawal
          // after that rejection produces rejected-with-reviewer-agreement.
          status = input.disposition === "resolved" ? "verifying" : "open";
          storedDisposition = input.disposition;
        }
        const reportRow: PullRequestMonitorFeedbackReport = {
          id: `fb_report_${stableHash([monitor.id, item.id, input.disposition, now])}`,
          monitorId: monitor.id,
          itemId: item.id,
          disposition: storedDisposition!,
          note: input.note ?? null,
          reporterThreadId: input.reporterThreadId ?? null,
          createdAt: now,
          actorRole,
        };
        yield* feedbackStore.reportDisposition({
          itemId: item.id,
          disposition: storedDisposition!,
          note: input.note ?? null,
          at: now,
          byThreadId: input.reporterThreadId ?? null,
          status,
          childDisposition,
          reviewerDisposition,
          report: reportRow,
          actorRole,
        });
        // Immediate post-report recheck so dispositions are verified against fresh PR state.
        yield* input.requestRecheck(monitor);
        const fresh = yield* feedbackStore.getItem(item.id);
        return {
          item: fresh ?? { ...item, disposition: input.disposition, status, dispositionAt: now },
          report: reportRow,
          recheckRequested: true,
          awaitingVerification: status === "verifying",
        };
      });

    return PullRequestMonitorFeedbackService.of({
      reconcileAndIngest,
      readinessSummary: summarize,
      ingestFindings,
      flushDueDeliveries,
      retryQueuedDelivery,
      context,
      report,
      listOpenItems,
      listDeliveries,
      listReports,
    });
  }),
);
