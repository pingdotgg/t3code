import { isListedThreadLineage, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";

export type WorkThread = Pick<
  AgentAwarenessState,
  | "environmentId"
  | "threadId"
  | "projectId"
  | "projectTitle"
  | "threadTitle"
  | "updatedAt"
  | "deepLink"
> & { readonly phase: AgentAwarenessState["phase"] | "idle" };

export interface WorkSnapshot {
  readonly recent: readonly WorkThread[];
  readonly review: readonly WorkThread[];
  readonly finished: number;
  readonly failed: number;
}

export function createWorkSnapshotBuilder() {
  const recent: WorkThread[] = [];
  const review: WorkThread[] = [];
  let finished = 0;
  let failed = 0;

  return {
    add(
      environmentId: WorkThread["environmentId"],
      project: { readonly id: string; readonly title: string },
      thread: OrchestrationV2ThreadShell,
      activity: AgentAwarenessState | null,
    ) {
      if (thread.deletedAt !== null || !isListedThreadLineage(thread.lineage)) return;
      const meaningfulAt = [
        thread.createdAt,
        thread.latestUserAuthoredMessageAt ?? thread.latestUserMessageAt,
        thread.latestVisibleMessage?.updatedAt,
        thread.latestRunRequestedAt,
        thread.latestRunStartedAt,
        thread.latestRunCompletedAt,
        thread.pendingRuntimeRequest?.createdAt,
      ].reduce(
        (latest, time) => Math.max(latest, time?.epochMilliseconds ?? latest),
        thread.createdAt.epochMilliseconds,
      );
      const row: WorkThread = {
        environmentId,
        threadId: thread.id,
        projectId: project.id,
        projectTitle: project.title,
        threadTitle: thread.title,
        phase: activity?.phase ?? "idle",
        updatedAt: new Date(meaningfulAt).toISOString(),
        deepLink:
          activity?.deepLink ??
          `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(thread.id)}`,
      };
      recent.push(row);

      const completedAt = thread.latestRunCompletedAt;
      const visit = thread.lastVisitedAt;
      if (
        !completedAt ||
        visit === undefined ||
        (visit !== null && completedAt.epochMilliseconds <= visit.epochMilliseconds) ||
        (row.phase !== "completed" && row.phase !== "failed")
      ) {
        return;
      }
      if (row.phase === "completed") finished += 1;
      else failed += 1;
      review.push({ ...row, updatedAt: DateTime.formatIso(completedAt) });
    },
    snapshot(): WorkSnapshot {
      const newest = (left: WorkThread, right: WorkThread) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.environmentId.localeCompare(right.environmentId) ||
        left.threadId.localeCompare(right.threadId);
      return {
        recent: recent.sort(newest).slice(0, 3),
        review: review.sort(newest).slice(0, 5),
        finished,
        failed,
      };
    },
  };
}
