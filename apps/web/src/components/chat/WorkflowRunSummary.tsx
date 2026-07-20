import type {
  ThreadId,
  WorkflowArtifact,
  WorkflowDefinition,
  WorkflowRun,
} from "@t3tools/contracts";
import { ChevronRightIcon, CircleCheckIcon, CircleXIcon, WorkflowIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface WorkflowRunPresentation {
  readonly run: WorkflowRun;
  readonly definition: WorkflowDefinition | undefined;
  readonly artifacts: ReadonlyArray<WorkflowArtifact>;
}

export function WorkflowRunsButton({
  runs,
  onNavigateThread,
}: {
  readonly runs: ReadonlyArray<WorkflowRunPresentation>;
  readonly onNavigateThread: (threadId: ThreadId) => void;
}) {
  if (runs.length === 0) {
    return null;
  }

  const runningCount = runs.filter((entry) => entry.run.status === "running").length;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  className="relative shrink-0 border-transparent shadow-none hover:border-input hover:shadow-xs/5"
                  variant="outline"
                  size="icon-xs"
                  aria-label="Workflow runs"
                >
                  <WorkflowIcon className="size-3" />
                  {runningCount > 0 ? (
                    <span className="absolute -right-1 -top-1 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-medium leading-none text-primary-foreground">
                      {runningCount}
                    </span>
                  ) : null}
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="bottom">Workflow runs</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="end" className="w-[min(28rem,calc(100vw-2rem))]">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <WorkflowIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Workflow runs
          </div>
          {runs.map((entry) => (
            <WorkflowRunCard key={entry.run.id} entry={entry} onNavigateThread={onNavigateThread} />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function WorkflowRunCard({
  entry,
  onNavigateThread,
}: {
  readonly entry: WorkflowRunPresentation;
  readonly onNavigateThread: (threadId: ThreadId) => void;
}) {
  const finalArtifact = entry.run.finalArtifactId
    ? entry.artifacts.find((artifact) => artifact.id === entry.run.finalArtifactId)
    : undefined;
  const resultArtifacts = entry.artifacts.filter(
    (artifact) =>
      artifact.payload.kind === "worker-result" || artifact.payload.kind === "final-result",
  );

  return (
    <div className="rounded-lg border border-border/45 bg-background/45 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 truncate font-medium">
          {entry.definition?.name ?? entry.run.workflowId}
        </span>
        <WorkflowStatus status={entry.run.status} />
      </div>
      <div className="mt-2 space-y-1.5">
        {entry.run.nodes.map((node) => {
          const nodeTitle =
            entry.definition?.nodes.find((definition) => definition.id === node.nodeId)?.title ??
            node.nodeId;
          const workerThreadId = node.workerThreadId;
          return (
            <div
              key={node.nodeId}
              className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
            >
              <ChevronRightIcon className="size-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{nodeTitle}</span>
              <WorkflowStatus status={node.status} />
              {workerThreadId ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="h-6 shrink-0 px-1.5 text-xs"
                  onClick={() => onNavigateThread(workerThreadId)}
                >
                  Open worker
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
      {finalArtifact?.payload.kind === "final-result" ? (
        <ArtifactDetails artifact={finalArtifact} onNavigateThread={onNavigateThread} />
      ) : (
        resultArtifacts.map((artifact) => (
          <ArtifactDetails
            key={artifact.id}
            artifact={artifact}
            onNavigateThread={onNavigateThread}
          />
        ))
      )}
    </div>
  );
}

function ArtifactDetails({
  artifact,
  onNavigateThread,
}: {
  readonly artifact: WorkflowArtifact;
  readonly onNavigateThread: (threadId: ThreadId) => void;
}) {
  if (artifact.payload.kind === "input-context") {
    return null;
  }

  const { body, evidence, summary } = artifact.payload;
  return (
    <details className="mt-2 rounded-md bg-muted/35 px-2 py-1.5 text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium text-foreground/85">{summary}</summary>
      {body ? <p className="mt-2 whitespace-pre-wrap break-words">{body}</p> : null}
      {evidence.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {evidence.map((item) => {
            const threadId = item.threadId;
            const key = `${item.label}:${threadId ?? ""}:${item.messageId ?? ""}`;
            return threadId ? (
              <Button
                key={key}
                type="button"
                size="xs"
                variant="outline"
                className="h-6 max-w-48 truncate px-1.5 text-xs"
                onClick={() => onNavigateThread(threadId)}
              >
                {item.label}
              </Button>
            ) : (
              <span key={key} className="rounded border border-border/50 px-1.5 py-0.5">
                {item.label}
              </span>
            );
          })}
        </div>
      ) : null}
    </details>
  );
}

function WorkflowStatus({
  status,
}: {
  readonly status: WorkflowRun["status"] | WorkflowRun["nodes"][number]["status"];
}) {
  const isFailure = status === "failed" || status === "cancelled";
  const isComplete = status === "completed";
  const Icon = isFailure ? CircleXIcon : isComplete ? CircleCheckIcon : null;

  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] capitalize text-muted-foreground">
      {Icon ? <Icon className="size-3" aria-hidden="true" /> : null}
      {status}
    </span>
  );
}
