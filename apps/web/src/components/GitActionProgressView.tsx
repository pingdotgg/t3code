import { useNowSecond } from "../hooks/useNowSecond";
import { cn } from "~/lib/utils";
import {
  formatGitActionElapsed,
  type GitActionProgressPresentation,
} from "./GitActionsControl.logic";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./chat/threadDetailsPanelStyles";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

function GitActionElapsedTime({
  startedAtMs,
  className,
}: {
  startedAtMs: number | null;
  className?: string;
}) {
  return startedAtMs === null ? null : (
    <RunningGitActionElapsedTime startedAtMs={startedAtMs} className={className} />
  );
}

function RunningGitActionElapsedTime({
  startedAtMs,
  className,
}: {
  startedAtMs: number;
  className: string | undefined;
}) {
  const nowMs = useNowSecond();
  const elapsed = formatGitActionElapsed(startedAtMs, nowMs);
  if (!elapsed) {
    return null;
  }

  return (
    <p aria-hidden="true" className={className}>
      {elapsed}
    </p>
  );
}

function GitActionProgressButtonContent({ progress }: { progress: GitActionProgressPresentation }) {
  const hasOutput = progress.output !== null;

  return (
    <div
      aria-atomic="false"
      aria-live="polite"
      className={cn(
        "grid min-w-0 flex-1 items-center",
        "grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[1.5rem] gap-x-3",
      )}
      role="status"
    >
      <Spinner aria-hidden="true" className="row-start-1 -mx-0.5 shrink-0" />
      <p className={cn("row-start-1 min-w-0 truncate text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
        {progress.status}
      </p>
      <GitActionElapsedTime
        startedAtMs={progress.startedAtMs}
        className="col-start-3 row-start-1 whitespace-nowrap text-2xs tabular-nums text-muted-foreground"
      />
      <div
        className={cn(
          "col-span-2 col-start-2 grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          hasOutput ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="truncate pt-0.5 text-left text-2xs font-normal text-muted-foreground" />
              }
            >
              {progress.output}
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-96 break-words">
              {progress.output}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

export function GitActionProgressView({
  progress,
}: {
  readonly progress: GitActionProgressPresentation;
}) {
  return (
    <div className="flex min-w-0 items-start rounded-lg bg-black/[0.035] dark:bg-white/[0.055]">
      <ThreadDetailsControl variant="ghost" multiline disabled part="row" panel>
        <GitActionProgressButtonContent progress={progress} />
      </ThreadDetailsControl>
    </div>
  );
}
