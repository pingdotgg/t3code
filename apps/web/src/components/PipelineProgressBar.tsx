import {
  countFinishedPipelineSegments,
  type PipelineProgressStatus,
} from "@t3tools/client-runtime/state/pipeline-nesting";
import type { ThreadId } from "@t3tools/contracts";

import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface PipelineProgressBarSegment {
  readonly stepId: string;
  readonly label: string;
  readonly status: PipelineProgressStatus;
  /** The step's latest thread; null until the step starts. */
  readonly threadId: ThreadId | null;
}

const PIPELINE_PROGRESS_SEGMENT_CLASS: Record<PipelineProgressStatus, string> = {
  completed: "bg-success",
  running: "bg-info",
  attention: "bg-indigo-500 dark:bg-indigo-400",
  failed: "bg-destructive",
  stopped:
    "bg-[repeating-linear-gradient(135deg,currentColor_0_2px,transparent_2px_4px)] text-muted-foreground/70",
  skipped: "bg-muted-foreground/35",
  pending: "bg-muted-foreground/15",
};

const PIPELINE_PROGRESS_STATUS_LABEL: Record<PipelineProgressStatus, string> = {
  completed: "Done",
  running: "Running",
  attention: "Needs you",
  failed: "Failed",
  stopped: "Stopped",
  skipped: "Skipped",
  pending: "Pending",
};

/** One segment per step, coloured by its status, with a done count. A started step's segment opens it. */
export function PipelineProgressBar(props: {
  segments: ReadonlyArray<PipelineProgressBarSegment>;
  onOpenStep: (threadId: ThreadId) => void;
  tooltipSide?: "left" | "right" | "top" | "bottom";
  className?: string;
}) {
  const { segments } = props;
  const finished = countFinishedPipelineSegments(segments);
  const summary = `${finished} of ${segments.length} steps done`;
  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-1.5", props.className)}>
      <Tooltip>
        <TooltipTrigger
          render={<div role="img" aria-label={summary} className="flex min-w-0 flex-1 gap-0.5" />}
        >
          {segments.map((segment) => {
            const threadId = segment.threadId;
            return (
              <span
                key={segment.stepId}
                aria-hidden
                className={cn("flex min-w-0 flex-1 py-1.5", threadId !== null && "cursor-pointer")}
                onClick={
                  threadId === null
                    ? undefined
                    : (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        props.onOpenStep(threadId);
                      }
                }
              >
                <span
                  className={cn(
                    "h-1 w-full rounded-full",
                    PIPELINE_PROGRESS_SEGMENT_CLASS[segment.status],
                  )}
                />
              </span>
            );
          })}
        </TooltipTrigger>
        <TooltipPopup side={props.tooltipSide ?? "right"}>
          <ol className="flex flex-col gap-0.5 text-xs">
            {segments.map((segment, index) => (
              <li key={segment.stepId} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "h-1 w-3 shrink-0 rounded-full",
                    PIPELINE_PROGRESS_SEGMENT_CLASS[segment.status],
                  )}
                />
                <span className="min-w-0 flex-1 truncate">
                  {index + 1}. {segment.label}
                </span>
                <span className="text-muted-foreground">
                  {PIPELINE_PROGRESS_STATUS_LABEL[segment.status]}
                </span>
              </li>
            ))}
          </ol>
        </TooltipPopup>
      </Tooltip>
      <span aria-hidden className="shrink-0 text-2xs text-secondary-label tabular-nums">
        {finished}/{segments.length}
      </span>
    </div>
  );
}
