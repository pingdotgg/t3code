import type {
  EnvironmentId,
  OrchestrationV2RunStatus,
  ProgramAttemptSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useThreadProjection } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const STATUS_LABELS: Record<OrchestrationV2RunStatus, string> = {
  preparing: "Preparing",
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  interrupted: "Interrupted",
  failed: "Failed",
  cancelled: "Cancelled",
  rolled_back: "Rolled back",
};

const STATUS_DOTS: Record<OrchestrationV2RunStatus, string> = {
  preparing: "bg-info",
  queued: "bg-muted-foreground/45",
  starting: "bg-info",
  running: "bg-success",
  waiting: "bg-warning",
  completed: "bg-success",
  interrupted: "bg-warning",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/45",
  rolled_back: "bg-warning",
};

export function programAttemptAttention(
  attempt: ProgramAttemptSnapshot,
  status: OrchestrationV2RunStatus,
) {
  const failure = attempt.terminalResult?.failure;
  if (failure?.message) return failure.message;
  if (status === "interrupted")
    return "T3 restarted. Dirtyloops will decide whether this Task retries.";
  if (status === "failed")
    return "The T3 run failed. Inspect the Dirtyloops record before retrying.";
  if (status === "cancelled") return "The T3 run was cancelled.";
  if (status === "rolled_back") return "The T3 run was rolled back.";
  return "None";
}

function DetailRow(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] gap-2 border-b border-border/45 py-1.5 last:border-b-0">
      <dt className="text-[11px] text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 text-[11px] text-foreground/80">{props.children}</dd>
    </div>
  );
}

export function ProgramAttemptSummary(props: {
  readonly attempt: ProgramAttemptSnapshot;
  readonly environmentId: EnvironmentId;
  readonly status: OrchestrationV2RunStatus;
  readonly loadError?: string | null;
}) {
  const { attempt, status } = props;
  const threadHref = `/${encodeURIComponent(props.environmentId)}/${encodeURIComponent(attempt.threadId)}`;
  const stopTarget = attempt.taskId ?? attempt.attemptId;
  return (
    <section
      aria-labelledby="thread-details-dirtyloops-heading"
      className="border-t border-border/65 px-3.5 pb-3 pt-3"
      data-thread-program-attempt
    >
      <h3
        id="thread-details-dirtyloops-heading"
        className="mb-1.5 text-[11px] font-medium text-muted-foreground"
      >
        Dirtyloops {attempt.attemptKind === "review" ? "review" : "task"}
      </h3>
      <dl className="m-0 min-w-0">
        <DetailRow label="Attempt">
          <span className="block truncate" title={attempt.title}>
            {attempt.title}
          </span>
        </DetailRow>
        {attempt.programId ? (
          <DetailRow label="Program">
            <span className="block truncate">{attempt.programId}</span>
          </DetailRow>
        ) : null}
        {attempt.taskId ? (
          <DetailRow label="Task">
            <span className="block truncate">{attempt.taskId}</span>
          </DetailRow>
        ) : null}
        {attempt.reviewKind ? (
          <DetailRow label="Review">
            <span className="font-medium">
              {attempt.reviewKind === "broad" ? "Broad" : "Focused"} review ·{" "}
              {STATUS_LABELS[status]}
            </span>
          </DetailRow>
        ) : null}
        {attempt.candidateId ? (
          <DetailRow label="Candidate">
            <span className="block truncate font-mono text-[10px]">{attempt.candidateId}</span>
          </DetailRow>
        ) : null}
        <DetailRow label="State">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOTS[status])}
            />
            {STATUS_LABELS[status]}
          </span>
        </DetailRow>
        <DetailRow label="Attention">
          <span className="break-words">{programAttemptAttention(attempt, status)}</span>
        </DetailRow>
        <DetailRow label="Worktree">
          <span className="block break-all font-mono text-[10px]">
            {attempt.checkout.worktreePath}
          </span>
        </DetailRow>
        <DetailRow label="Branch">
          <span className="block truncate font-mono text-[10px]">{attempt.checkout.branch}</span>
        </DetailRow>
        <DetailRow label="Start">
          <span className="font-mono text-[10px]">
            {attempt.checkout.startingCommit.slice(0, 12)}
          </span>
        </DetailRow>
        <DetailRow label="T3 run">
          <a
            href={threadHref}
            className="inline-flex max-w-full items-center gap-1 text-foreground/85 underline decoration-border underline-offset-2 hover:decoration-foreground/70"
          >
            <span className="truncate font-mono text-[10px]">{attempt.runId}</span>
            <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </a>
        </DetailRow>
      </dl>
      {props.loadError ? (
        <p className="mt-2 text-[11px] leading-relaxed text-warning">
          Live details may be stale: {props.loadError}
        </p>
      ) : null}
      <div className="mt-2 border-t border-border/45 pt-2">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Program controls run in the prepared checkout.
        </p>
        <code className="mt-1 block whitespace-pre-wrap break-words text-[10px] leading-relaxed text-foreground/70">
          {`dirtyloops inspect\ndirtyloops run <proposal.json>\ndirtyloops stop ${stopTarget}`}
        </code>
      </div>
    </section>
  );
}

export function ThreadProgramAttemptPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.programAttempt({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const projection = useThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  if (query.data === null) return null;
  const attempt = query.data;
  const liveStatus = projection?.projection.runs.find((run) => run.id === attempt.runId)?.status;
  return (
    <ProgramAttemptSummary
      attempt={attempt}
      environmentId={props.environmentId}
      status={liveStatus ?? attempt.runStatus}
      loadError={query.error}
    />
  );
}
