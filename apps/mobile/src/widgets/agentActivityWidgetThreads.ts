import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  buildThreadListV2Items,
  resolveThreadListV2Status,
} from "../features/threads/threadListV2";
import type { AgentActivityWidgetProps } from "./AgentActivityWidget";

type Row = AgentActivityWidgetProps["activities"][number];

function activityStatus(thread: EnvironmentThreadShell): Pick<Row, "phase" | "status"> {
  switch (resolveThreadListV2Status(thread)) {
    case "approval":
      return { phase: "waiting_for_approval", status: "Approval" };
    case "input":
      return { phase: "waiting_for_input", status: "Input" };
    case "request":
      return { phase: "waiting_for_input", status: "Request" };
    case "working":
      return { phase: "running", status: "Working" };
    case "failed":
      return { phase: "failed", status: "Failed" };
    case "limited":
      return { phase: "failed", status: "Limited" };
    case "waiting":
      return { phase: "stale", status: "Waiting" };
    case "ready":
      return thread.latestRun?.status === "completed"
        ? { phase: "completed", status: "Done" }
        : { phase: "stale", status: "Ready" };
  }
}

export function buildWidgetUnsettledRows(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id" | "title">>;
  readonly excluded: AgentActivityWidgetProps["activities"];
  readonly now: string;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys: ReadonlySet<string>;
}): AgentActivityWidgetProps["activities"] {
  const seen = new Set(
    input.excluded.map((row) => JSON.stringify([row.environmentId, row.threadId])),
  );
  const projects = new Map(
    input.projects.map((p) => [JSON.stringify([p.environmentId, p.id]), p.title]),
  );
  const layout = buildThreadListV2Items({
    threads: input.threads.filter((thread) => thread.deletedAt === null),
    environmentId: null,
    searchQuery: "",
    now: input.now,
    settlementEnvironmentIds: input.settlementEnvironmentIds,
    snoozeEnvironmentIds: input.settlementEnvironmentIds,
    queuedThreadKeys: input.queuedThreadKeys,
    settledLimit: 0,
  });
  return layout.items
    .filter(({ variant, snoozed }) => variant === "card" && !snoozed)
    .flatMap(({ thread }) => {
      const key = JSON.stringify([thread.environmentId, thread.id]);
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          environmentId: thread.environmentId,
          threadId: thread.id,
          projectTitle:
            projects.get(JSON.stringify([thread.environmentId, thread.projectId])) ?? "Project",
          threadTitle: thread.title,
          ...activityStatus(thread),
          deepLink: `/threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.id)}`,
        },
      ];
    })
    .slice(0, 7);
}
