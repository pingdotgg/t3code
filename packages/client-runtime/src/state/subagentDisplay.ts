import type {
  OrchestrationV2TurnItemStatus,
  OrchestrationV2ThreadShell,
  OrchestrationProjectShell,
  ServerProvider,
} from "@t3tools/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { fileBasename } from "../markdownLinks.ts";
import { isTerminalSubagentStatus } from "./subagentRuntime.ts";

/** Summarizes one adjacent group, without changing its member identities or order. */
export function subagentGroupSummary(
  members: ReadonlyArray<{ readonly status: OrchestrationV2TurnItemStatus }>,
) {
  const active = members.some(
    ({ status }) => status === "pending" || status === "running" || status === "waiting",
  );
  return {
    label: `${active ? "Kicked off" : "Ran"} ${members.length} ${members.length === 1 ? "subagent" : "subagents"}`,
    active,
    failed: members.some(({ status }) => status === "failed"),
  };
}

/**
 * Counts a group's states in the order a reader scans them: what is still
 * running first, then outcomes, using the agents panel's words.
 */
export function summarizeSubagentStatuses(
  statuses: ReadonlyArray<OrchestrationV2TurnItemStatus>,
): string {
  const counts = { working: 0, done: 0, failed: 0, stopped: 0, idle: 0 };
  for (const status of statuses) {
    if (status === "pending" || status === "running" || status === "waiting") counts.working += 1;
    else if (status === "completed") counts.done += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "idle") counts.idle += 1;
    else counts.stopped += 1;
  }
  return (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`)
    .join(" · ");
}

/** Formats Codex task paths for display while leaving provider identity untouched. */
export function formatSubagentDisplayTitle(title: string): string {
  const displayTitle = title.replace(/^Subagent:\s*/i, "");
  const path = /^\/root\/(?:[^/]+\/)*([^/]+)\/?$/u.exec(displayTitle);
  if (path === null) return displayTitle;

  const name = path[1]!.replace(/[_\s]+/gu, " ").trim();
  return name.replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase()) || displayTitle;
}

/** Match desktop's model resolution and show only changes from the parent's workspace. */
export function resolveSubagentMetadata(input: {
  readonly model: string | null;
  readonly provider?: Pick<ServerProvider, "driver" | "models"> | null | undefined;
  readonly parentThread?:
    | Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath">
    | null
    | undefined;
  readonly childThread?:
    | Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath">
    | null
    | undefined;
  readonly parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | null | undefined;
  readonly childProject?:
    | Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot">
    | null
    | undefined;
}) {
  const model = input.model?.trim();
  const slug = input.provider
    ? resolveSelectableModel(input.provider.driver, model, input.provider.models)
    : model;
  const catalogModel = input.provider?.models.find((candidate) => candidate.slug === slug);
  const reportedLabel = catalogModel
    ? catalogModel.shortName || catalogModel.name
    : model
      ? formatModelSlugName(model)
      : "Not reported";
  const qualifier = catalogModel?.subProvider?.trim();
  const modelLabel = qualifier
    ? reportedLabel
        .replace(
          new RegExp(
            `^${qualifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*[.:/-]\\s*|\\s+)`,
            "iu",
          ),
          "",
        )
        .trim() || reportedLabel
    : reportedLabel;
  const parentWorkspace = input.parentThread?.worktreePath ?? input.parentProject?.workspaceRoot;
  const childWorkspace = input.childThread?.worktreePath ?? input.childProject?.workspaceRoot;
  const workspace = [
    ...(input.parentThread &&
    input.childProject &&
    input.childProject.id !== input.parentThread.projectId
      ? [{ label: "Project", value: input.childProject.title }]
      : []),
    ...(parentWorkspace && childWorkspace && parentWorkspace !== childWorkspace
      ? [
          {
            label: input.childThread?.branch
              ? "Branch"
              : input.childThread?.worktreePath
                ? "Worktree"
                : "Workspace",
            value: input.childThread?.branch ?? fileBasename(childWorkspace),
          },
        ]
      : []),
  ];
  return { modelLabel, workspace };
}

/** Live work leads with progress; settled work leads with its result. */
export function subagentDetailPreview(input: {
  readonly status: OrchestrationV2TurnItemStatus;
  readonly result?: string | null | undefined;
  readonly progress?: string | null | undefined;
}): string | null {
  const result = input.result?.trim();
  const progress = input.progress?.trim();
  const detail =
    (isTerminalSubagentStatus(input.status) ? result || progress : progress || result) || "";
  const compact = detail.replace(/\s+/gu, " ");
  return compact.length > 280 ? `${compact.slice(0, 280).trimEnd()}…` : compact || null;
}
