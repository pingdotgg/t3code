import type {
  LinearActivityItem,
  LinearActivityResult,
  LinearActivityStatus,
  LinearIssueActivity,
  OrchestrationV2ShellThreadStatus,
  PipelineRun,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as PipelineService from "../pipelines/PipelineService.ts";
import * as LinearLinkStore from "./LinearLinkStore.ts";

/** Activity is read on every Linear page refresh; the newest links are what people look at. */
const ACTIVITY_LINK_LIMIT = 200;

function threadActivityStatus(status: OrchestrationV2ShellThreadStatus): LinearActivityStatus {
  switch (status) {
    case "idle":
    case "interrupted":
    case "rolled_back":
      return "idle";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function pipelineActivityStatus(run: PipelineRun): LinearActivityStatus {
  switch (run.status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "paused":
      return run.pauseReason === "step_failed" ? "failed" : "paused";
  }
}

function pipelineItemDetails(run: PipelineRun): NonNullable<LinearActivityItem["pipeline"]> {
  const steps = run.steps.map((step) => ({
    name:
      run.definition.steps.find((candidate) => candidate.id === step.stepId)?.name ?? step.stepId,
    status: step.status,
  }));
  const current =
    run.status === "running" || run.status === "paused" ? steps[run.currentStepIndex] : undefined;
  const failed = run.steps.findIndex((step) => step.status === "failed");
  return {
    name: run.definition.name,
    steps,
    currentStepName: current?.name ?? null,
    failedStepName: failed >= 0 ? (steps[failed]?.name ?? null) : null,
  };
}

/**
 * Joins stored links with the live thread and pipeline state. Links whose thread or run was
 * deleted drop out, and a read failure on one item never hides the others.
 */
export const computeLinearActivity = Effect.fn("LinearActivity.compute")(function* (
  store: LinearLinkStore.LinearLinkStore["Service"],
  pipelines: PipelineService.PipelineService["Service"],
  projection: ProjectionStore.ProjectionStoreV2["Service"],
) {
  const links = yield* store.list(ACTIVITY_LINK_LIMIT);

  const itemFor = Effect.fn("LinearActivity.item")(function* (stored: LinearLinkStore.StoredLink) {
    if (stored.link.targetKind === "thread") {
      const shell = yield* projection.getThreadShell(stored.link.targetId as ThreadId);
      if (shell === null || shell.deletedAt !== null) return null;
      const messageCount = yield* projection.getMessageCount(shell.id);
      return {
        link: stored.link,
        title: shell.title,
        provider: shell.providerInstanceId,
        messageCount,
        status: threadActivityStatus(shell.status),
        updatedAt: DateTime.formatIso(shell.updatedAt),
        pipeline: null,
      } satisfies LinearActivityItem;
    }
    // The run lives on another machine; this server can only report that it was launched.
    if (stored.link.environmentId != null) {
      return {
        link: stored.link,
        title: "Pipeline run",
        provider: null,
        messageCount: null,
        status: "idle",
        updatedAt: stored.link.createdAt,
        pipeline: null,
      } satisfies LinearActivityItem;
    }
    const run = yield* pipelines.getRun(stored.link.targetId as PipelineRun["id"]);
    return {
      link: stored.link,
      title: run.definition.name,
      provider: null,
      messageCount: null,
      status: pipelineActivityStatus(run),
      updatedAt: run.updatedAt,
      pipeline: pipelineItemDetails(run),
    } satisfies LinearActivityItem;
  });

  const items = yield* Effect.forEach(
    links,
    (stored) =>
      itemFor(stored).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Skipping unreadable Linear activity item", {
            linkId: stored.link.linkId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      ),
    { concurrency: 8 },
  );

  const byIssue = new Map<string, LinearActivityItem[]>();
  for (const item of items) {
    if (item === null) continue;
    const list = byIssue.get(item.link.issueId) ?? [];
    list.push(item);
    byIssue.set(item.link.issueId, list);
  }

  const issues: LinearIssueActivity[] = [];
  for (const [issueId, issueItems] of byIssue) {
    const first = issueItems[0];
    if (first === undefined) continue;
    const sorted = issueItems.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    issues.push({
      issueId,
      issueIdentifier: first.link.issueIdentifier,
      teamId: first.link.teamId,
      items: sorted,
      latestActivityAt: sorted[0]?.updatedAt ?? first.updatedAt,
      runningCount: sorted.filter((item) => item.status === "running").length,
      threadCount: sorted.filter((item) => item.link.targetKind === "thread").length,
      pipelineRunning: sorted.some((item) => item.pipeline !== null && item.status === "running"),
      pipelineFailed: sorted.some((item) => item.pipeline !== null && item.status === "failed"),
    });
  }
  issues.sort((a, b) => b.latestActivityAt.localeCompare(a.latestActivityAt));
  return { issues } satisfies LinearActivityResult;
});
