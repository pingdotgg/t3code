import type {
  GitPullRequestAssociation,
  OrchestrationLatestTurn,
  OrchestrationSession,
  ReviewSnapshot,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  seedLegacyThreadPullRequestLink,
  upsertLegacyThreadPullRequestLink,
} from "@t3tools/shared/threadPullRequests";

import { pullRequestFromReviewSnapshot } from "../reviewPullRequest.ts";

/**
 * Single authority for projection policy shared by the in-memory read-model
 * projector (`orchestration/projector.ts`) and the durable SQL pipeline
 * (`orchestration/Layers/ProjectionPipeline.ts`), plus the SQL windowing in
 * `Layers/ProjectionSnapshotQuery.ts`.
 *
 * Both projections must agree on retention windows, revert trimming,
 * pull-request link ordering, and session-to-turn mapping; otherwise snapshots
 * diverge silently (revert/turn-window/PR-state). This module owns those pure
 * decisions behind one narrow interface. Adapters (in-memory vs SQL) keep only
 * their storage shapes.
 */

// Retention windows. Snapshot SQL windowing must use these same constants.
export const MAX_THREAD_MESSAGES = 2_000;
export const MAX_THREAD_ACTIVITIES = 500;
export const MAX_THREAD_CHECKPOINTS = 500;
export const MAX_THREAD_PROPOSED_PLANS = 200;

// Trimmed-id deletes use IN lists, which cannot be split across statements
// the way keep-lists can: chunk the trimmed ids so a pathological thread
// cannot exceed the SQLite variable limit in one statement.
export const REVERT_TRIM_DELETE_BATCH_SIZE = 500;

export interface RevertMessageKey {
  readonly messageId: string;
  readonly turnId: string | null;
  readonly role: string;
  readonly createdAt: string;
}

export interface RevertTurnRef {
  readonly turnId: string | null;
  readonly checkpointTurnCount: number | null;
  readonly pendingMessageId?: string | null;
  readonly assistantMessageId?: string | null;
}

export function checkpointStatusToLatestTurnState(
  status: "ready" | "missing" | "speculative" | "error",
): "completed" | "running" | "interrupted" | "error" {
  if (status === "error") return "error";
  if (status === "missing") return "interrupted";
  if (status === "speculative") return "running";
  return "completed";
}

export function isNonAuthoritativeCheckpointStatus(status: string | undefined): boolean {
  return status === "missing" || status === "speculative";
}

export function terminalTurnStateForSessionStatus(status: string): "error" | "interrupted" {
  return status === "error" ? "error" : "interrupted";
}

/**
 * Session-to-turn mapping: how a thread's latest turn is reconciled against its
 * provider session.
 *
 * Both projections must answer this identically, because the decider reads the
 * in-memory result while clients read the SQL one — if they disagree about
 * whether a turn is still running, a dispatch the server would admit is refused
 * in the UI, or the reverse.
 *
 * - A running session with an active turn is authoritative: it either keeps the
 *   existing turn's timestamps and assistant message, or starts a fresh record
 *   for the newly active turn.
 * - A turn still marked running under a session that is no longer running has
 *   been orphaned by the session ending, so it is terminalised rather than
 *   reported as live forever.
 */
export function reconcileLatestTurnWithSession(
  latestTurn: OrchestrationLatestTurn | null,
  session: OrchestrationSession | null,
): OrchestrationLatestTurn | null {
  if (session === null) {
    return latestTurn;
  }
  if (session.status === "running" && session.activeTurnId !== null) {
    if (latestTurn?.turnId === session.activeTurnId) {
      return {
        ...latestTurn,
        state: "running",
        startedAt: latestTurn.startedAt ?? session.updatedAt,
        completedAt: null,
      };
    }
    return {
      turnId: session.activeTurnId,
      state: "running",
      requestedAt: session.updatedAt,
      startedAt: session.updatedAt,
      completedAt: null,
      assistantMessageId: null,
    };
  }
  if (latestTurn?.state === "running") {
    return {
      ...latestTurn,
      state: terminalTurnStateForSessionStatus(session.status),
      completedAt: session.updatedAt,
    };
  }
  return latestTurn;
}

/**
 * Provider sessions omit `activeMessageId` while the same turn stays active.
 * Both projections must preserve the previous value in that case instead of
 * clearing it.
 */
export function shouldPreserveActiveMessageId(input: {
  readonly activeTurnId: string | null;
  readonly activeMessageId: string | null | undefined;
}): boolean {
  return input.activeTurnId !== null && input.activeMessageId === undefined;
}

export interface InitialThreadPullRequest {
  readonly initialPullRequest: GitPullRequestAssociation | undefined;
  readonly source: ThreadPullRequestLink["source"] | undefined;
}

/**
 * `thread.created` carries either an explicit association or a legacy review
 * snapshot that itself is PR provenance. Both projections must resolve it the
 * same way, including the `created` vs `recovered` source.
 */
export function resolveInitialThreadPullRequest(input: {
  readonly pullRequest: GitPullRequestAssociation | null | undefined;
  readonly reviewSnapshot: ReviewSnapshot | null | undefined;
}): InitialThreadPullRequest {
  if (input.pullRequest !== undefined) {
    return {
      initialPullRequest: input.pullRequest ?? undefined,
      source: input.pullRequest === null ? undefined : "created",
    };
  }
  const legacy = pullRequestFromReviewSnapshot(input.reviewSnapshot);
  return {
    initialPullRequest: legacy,
    source: legacy === undefined ? undefined : "recovered",
  };
}

export interface MetaUpdatedPullRequestPlan {
  readonly allLinks: ReadonlyArray<ThreadPullRequestLink>;
  /** Present when a missing legacy association was seeded ahead of newer links. */
  readonly recoveredLegacyLink: ThreadPullRequestLink | undefined;
}

/**
 * `thread.meta-updated` pull-request replacement must seed any missing legacy
 * association ahead of newer `pullRequests` in both projections; otherwise the
 * first-created PR disappears or loses primary badge order.
 */
export function planMetaUpdatedPullRequestLinks(input: {
  readonly existingLinks: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly existingLegacyPullRequest: GitPullRequestAssociation | null | undefined;
  readonly createdAt: string;
  readonly nextPullRequest: GitPullRequestAssociation;
  readonly updatedAt: string;
  readonly source: ThreadPullRequestLink["source"] | undefined;
}): MetaUpdatedPullRequestPlan {
  const seeded = seedLegacyThreadPullRequestLink(
    input.existingLinks,
    input.existingLegacyPullRequest,
    input.createdAt,
  );
  const recoveredLegacyLink =
    seeded.length > (input.existingLinks ?? []).length ? seeded[0] : undefined;
  const allLinks = upsertLegacyThreadPullRequestLink(
    seeded,
    input.nextPullRequest,
    input.updatedAt,
    input.source,
  );
  return { allLinks, recoveredLegacyLink };
}

/**
 * Turn ids retained after `thread.reverted`: every turn whose checkpoint was
 * captured at or before the revert target. Checkpoints and durable turns share
 * this predicate (`checkpointTurnCount <= turnCount`).
 */
export function selectRetainedTurnIds(
  turns: ReadonlyArray<{
    readonly turnId: string | null;
    readonly checkpointTurnCount: number | null;
  }>,
  turnCount: number,
): Array<string> {
  return [
    ...new Set(
      turns.flatMap((turn) =>
        turn.turnId !== null &&
        turn.checkpointTurnCount !== null &&
        turn.checkpointTurnCount <= turnCount
          ? [turn.turnId]
          : [],
      ),
    ),
  ];
}

/**
 * Message ids retained after `thread.reverted`: system messages always, plus
 * messages whose turn survived, plus a creation-ordered fallback that fills
 * user/assistant counts up to `turnCount` (covers null-turn messages the
 * turn filter would otherwise drop). The durable pipeline additionally retains
 * pending/assistant message ids recorded on kept turns; pass those via
 * `extraRetainedMessageIds`.
 */
export function selectRetainedMessageIds(
  messages: ReadonlyArray<RevertMessageKey>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
  extraRetainedMessageIds: ReadonlySet<string> = new Set(),
): Set<string> {
  const retainedMessageIds = new Set<string>(extraRetainedMessageIds);

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return retainedMessageIds;
}

/** Extra message ids kept turns carry (durable turns only). */
export function extraRetainedMessageIdsFromTurns(
  turns: ReadonlyArray<RevertTurnRef>,
  turnCount: number,
): Set<string> {
  const extra = new Set<string>();
  for (const turn of turns) {
    if (
      turn.turnId === null ||
      turn.checkpointTurnCount === null ||
      turn.checkpointTurnCount > turnCount
    ) {
      continue;
    }
    if (turn.pendingMessageId !== null && turn.pendingMessageId !== undefined) {
      extra.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null && turn.assistantMessageId !== undefined) {
      extra.add(turn.assistantMessageId);
    }
  }
  return extra;
}

// Turn-based trim shared by the activity/plan revert handlers: present turn
// ids minus retained turn ids. A NOT IN keep-list cannot be chunked across
// statements (each chunk would delete rows kept by the other chunks), so the
// trimmed set is computed in JS and deleted with chunked IN lists instead.
export function selectTrimmedTurnIds(
  presentTurnIds: ReadonlyArray<string>,
  retainedTurnIds: ReadonlyArray<string>,
): Array<string> {
  if (retainedTurnIds.length === 0) {
    return [...presentTurnIds];
  }
  const retained = new Set(retainedTurnIds);
  return presentTurnIds.filter((turnId) => !retained.has(turnId));
}

export function chunkRevertTrimIds(
  ids: ReadonlyArray<string>,
  batchSize: number = REVERT_TRIM_DELETE_BATCH_SIZE,
): Array<Array<string>> {
  const chunks: Array<Array<string>> = [];
  for (let index = 0; index < ids.length; index += batchSize) {
    chunks.push(ids.slice(index, index + batchSize));
  }
  return chunks;
}
