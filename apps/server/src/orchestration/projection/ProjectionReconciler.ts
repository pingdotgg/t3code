import { ApprovalRequestId, type ThreadId } from "@t3tools/contracts";
import { Context, Effect, FileSystem, Layer, Option, Path, Semaphore } from "effect";
import type * as PlatformError from "effect/PlatformError";

import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionReconciliationJobRepository } from "../../persistence/Services/ProjectionReconciliationJobs.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

function staleUserInputFailure(detail: string | null): boolean {
  return (
    detail !== null &&
    (detail.includes("stale pending user-input request") ||
      detail.includes("unknown pending user-input request"))
  );
}

function derivePendingUserInputCount(
  activities: ReadonlyArray<{
    readonly activityId: string;
    readonly kind: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }>,
): number {
  const openRequestIds = new Set<string>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );

  for (const activity of ordered) {
    const requestId = extractActivityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;

    if (activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      activity.kind === "provider.user-input.respond.failed" &&
      staleUserInputFailure(detail)
    ) {
      openRequestIds.delete(requestId);
    }
  }

  return openRequestIds.size;
}

function deriveHasActionableProposedPlan(input: {
  readonly latestTurnId: string | null;
  readonly proposedPlans: ReadonlyArray<{
    readonly planId: string;
    readonly turnId: string | null;
    readonly implementedAt: string | null;
    readonly updatedAt: string;
  }>;
}): boolean {
  const sorted = [...input.proposedPlans].toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.planId.localeCompare(right.planId),
  );
  const latestForTurn =
    input.latestTurnId === null
      ? null
      : (sorted.findLast((plan) => plan.turnId === input.latestTurnId) ?? null);
  const latestPlan = latestForTurn ?? sorted.at(-1) ?? null;
  return latestPlan !== null && latestPlan.implementedAt === null;
}

// Match the file-backed Node SQLite read pool while bounding bootstrap fan-out.
const MAX_CONCURRENT_SHELL_SUMMARY_REFRESHES = 4;

interface ProjectionReconcilerShape {
  readonly drain: Effect.Effect<void, ProjectionRepositoryError | PlatformError.PlatformError>;
}

export class ProjectionReconciler extends Context.Service<
  ProjectionReconciler,
  ProjectionReconcilerShape
>()("t3/orchestration/projection/ProjectionReconciler") {}

const makeProjectionReconciler = Effect.gen(function* () {
  const jobs = yield* ProjectionReconciliationJobRepository;
  const threads = yield* ProjectionThreadRepository;
  const messages = yield* ProjectionThreadMessageRepository;
  const proposedPlans = yield* ProjectionThreadProposedPlanRepository;
  const activities = yield* ProjectionThreadActivityRepository;
  const pendingApprovals = yield* ProjectionPendingApprovalRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const drainLock = yield* Semaphore.make(1);

  const refreshShellSummary = Effect.fn("refreshProjectionThreadShellSummary")(function* (
    threadId: ThreadId,
  ) {
    const existing = yield* threads.getById({ threadId });
    if (Option.isNone(existing)) {
      return;
    }
    // Targeted summary reads: index-backed aggregates and narrow lifecycle
    // scans. This refresh must never fetch full message text, attachments,
    // plan markdown, or unrelated activity payloads: on the single-connection
    // SQLite client, fewer decoded rows beats fanning out full-history scans.
    const [latestUserMessageAt, pendingApprovalCount, userInputActivities, threadPlans] =
      yield* Effect.all(
        [
          messages.getLatestUserMessageAt({ threadId }),
          pendingApprovals.countPendingByThreadId({ threadId }),
          activities.listUserInputLifecycleByThreadId({ threadId }),
          proposedPlans.listSummariesByThreadId({ threadId }),
        ],
        { concurrency: "unbounded" },
      );

    yield* threads.upsert({
      ...existing.value,
      latestUserMessageAt,
      pendingApprovalCount,
      pendingUserInputCount: derivePendingUserInputCount(userInputActivities),
      hasActionableProposedPlan: deriveHasActionableProposedPlan({
        latestTurnId: existing.value.latestTurnId,
        proposedPlans: threadPlans,
      })
        ? 1
        : 0,
    });
  });

  const readAttachmentEntries = fileSystem
    .readDirectory(serverConfig.attachmentsDir, {
      recursive: false,
    })
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed([] as Array<string>) : Effect.fail(error),
      ),
    );

  const reconcileAttachments = Effect.fn("reconcileProjectionThreadAttachments")(function* (
    threadId: ThreadId,
  ) {
    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      return yield* Effect.logWarning("skipping attachment reconciliation for unsafe thread", {
        threadId,
      });
    }
    const thread = yield* threads.getById({ threadId });
    const keptRelativePaths = new Set<string>();
    if (Option.isSome(thread) && thread.value.deletedAt === null) {
      // Narrow attachment-only read: reconciliation never inspects message
      // text or origins, so full message rows are never decoded.
      const threadMessages = yield* messages.listAttachmentRefsByThreadId({ threadId });
      for (const message of threadMessages) {
        for (const attachment of message.attachments ?? []) {
          if (parseThreadSegmentFromAttachmentId(attachment.id) === threadSegment) {
            keptRelativePaths.add(attachmentRelativePath(attachment));
          }
        }
      }
    }

    const entries = yield* readAttachmentEntries;
    yield* Effect.forEach(
      entries,
      (entry) => {
        const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
        if (relativePath.length === 0 || relativePath.includes("/")) {
          return Effect.void;
        }
        const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
        if (
          !attachmentId ||
          parseThreadSegmentFromAttachmentId(attachmentId) !== threadSegment ||
          keptRelativePaths.has(relativePath)
        ) {
          return Effect.void;
        }
        const absolutePath = path.join(serverConfig.attachmentsDir, relativePath);
        return fileSystem.stat(absolutePath).pipe(
          Effect.flatMap((fileInfo) =>
            fileInfo.type === "File"
              ? fileSystem.remove(absolutePath, { force: true })
              : Effect.void,
          ),
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
          ),
        );
      },
      { concurrency: 1, discard: true },
    );
  });

  const drain = drainLock.withPermit(
    Effect.gen(function* () {
      const pending = yield* jobs.listPending();
      if (pending.length === 0) {
        return;
      }
      const shellThreadIds = new Set(pending.flatMap((job) => job.shellThreadIds));
      const attachmentThreadIds = new Set(pending.flatMap((job) => job.attachmentThreadIds));
      yield* Effect.forEach(shellThreadIds, refreshShellSummary, {
        concurrency: MAX_CONCURRENT_SHELL_SUMMARY_REFRESHES,
        discard: true,
      });
      yield* Effect.forEach(attachmentThreadIds, reconcileAttachments, {
        concurrency: 1,
        discard: true,
      });
      yield* jobs.completeThrough({
        sequence: pending.at(-1)!.sequence,
      });
    }),
  ) satisfies Effect.Effect<void, ProjectionRepositoryError | PlatformError.PlatformError>;

  return { drain } satisfies ProjectionReconcilerShape;
});

export const ProjectionReconcilerLive = Layer.effect(
  ProjectionReconciler,
  makeProjectionReconciler,
);
