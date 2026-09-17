import type {
  OrchestrationV2ThreadShell,
  OrchestrationProjectShell,
  ServerProvider,
} from "@t3tools/contracts";
import { fileBasename } from "@t3tools/client-runtime/markdown-links";
import { formatModelSlugName } from "@t3tools/shared/model";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import { Fragment } from "react";

/** Geometry and preview limits stay identical in lineage and timeline tooltips. */
export function SubagentTooltipContent(props: {
  title: string;
  model: string | null;
  provider?: ServerProvider | undefined;
  parentThread?: Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath"> | undefined;
  childThread?: Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath"> | undefined;
  parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | undefined;
  childProject?: Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot"> | undefined;
  status: string;
  result?: string | null | undefined;
  progress?: string | null | undefined;
}) {
  const providerModel = props.provider?.models.find((candidate) => candidate.slug === props.model);
  const modelLabel = providerModel
    ? getTriggerDisplayModelName(providerModel)
    : props.model
      ? formatModelSlugName(props.model)
      : "Unknown";
  const currentWorkspace = props.parentThread?.worktreePath ?? props.parentProject?.workspaceRoot;
  const childWorkspace = props.childThread?.worktreePath ?? props.childProject?.workspaceRoot;
  const metadata = [
    ...(props.parentThread &&
    props.childProject &&
    props.childProject.id !== props.parentThread.projectId
      ? [{ label: "Project", value: props.childProject.title }]
      : []),
    ...(currentWorkspace && childWorkspace && currentWorkspace !== childWorkspace
      ? [
          {
            label: props.childThread?.branch
              ? "Branch"
              : props.childThread?.worktreePath
                ? "Worktree"
                : "Workspace",
            value: props.childThread?.branch ?? fileBasename(childWorkspace),
          },
        ]
      : []),
  ];
  const settled = ["completed", "failed", "cancelled", "interrupted"].includes(props.status);
  const result = props.result?.trim();
  const progress = props.progress?.trim();
  const detail = (settled ? result || progress : progress || result) || "";
  const compactDetail = detail.trim().replace(/\s+/g, " ");
  const preview =
    compactDetail.length > 280 ? `${compactDetail.slice(0, 280).trimEnd()}…` : compactDetail;
  return (
    <div className="max-w-72 space-y-1 py-1">
      <div className="truncate font-medium">{props.title}</div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Model</dt>
        <dd className="break-words text-right">{modelLabel}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd className="text-right capitalize">{props.status.replaceAll("_", " ")}</dd>
        {metadata.map(({ label, value }) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words text-right">{value}</dd>
          </Fragment>
        ))}
      </dl>
      {preview ? <p className="line-clamp-3 break-words text-muted-foreground">{preview}</p> : null}
    </div>
  );
}
