import { SquareIcon, XIcon } from "lucide-react";

import { isProjectScriptRunActive, projectScriptRunStatusLabel } from "../../projectScriptRuns";
import { cn } from "../../lib/utils";
import { useProjectScriptRunActions } from "../../hooks/useProjectScriptRuns";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { ProjectScriptRunStatusIcon } from "./ProjectScriptRunStatusIcon";

export function ProjectScriptRunsBar() {
  const { runsList, canOperate, projectForRun, stopRun, dismissRun, selectRun } =
    useProjectScriptRunActions();
  const primary = runsList[0];
  if (primary === undefined) return null;

  const project = projectForRun(primary);
  const active = isProjectScriptRunActive(primary);
  const failed = primary.status === "failed";
  const remaining = runsList.length - 1;

  return (
    <div className="mx-2 mb-1 flex items-center gap-1 rounded-md border border-border/60 bg-accent/40 px-1.5 py-1">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-0.5 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => selectRun(primary.id)}
      >
        {project !== null ? (
          <ProjectFavicon project={project} className="size-3.5 shrink-0" />
        ) : null}
        {active ? null : (
          <ProjectScriptRunStatusIcon
            status={primary.status}
            className={cn(
              "size-3.5 shrink-0",
              failed
                ? "text-destructive"
                : primary.status === "succeeded"
                  ? "text-success-foreground"
                  : "text-muted-foreground",
            )}
          />
        )}
        <span className="max-w-24 shrink-0 truncate text-xs font-medium">{primary.scriptName}</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-2xs",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {failed
            ? (primary.errorMessage ?? "Failed")
            : active
              ? projectScriptRunStatusLabel(primary.status)
              : primary.projectTitle}
        </span>
        {remaining > 0 ? (
          <span className="shrink-0 text-2xs text-muted-foreground">+{remaining}</span>
        ) : null}
      </button>
      {active ? (
        <Button
          size="icon-micro"
          variant="ghost"
          aria-label={`Stop ${primary.scriptName}`}
          disabled={!canOperate(primary.environmentId)}
          onClick={() => void stopRun(primary)}
        >
          <SquareIcon className="size-3 text-destructive" />
        </Button>
      ) : (
        <Button
          size="icon-micro"
          variant="ghost"
          aria-label={`Dismiss ${primary.scriptName}`}
          onClick={() => dismissRun(primary)}
        >
          <XIcon className="size-3" />
        </Button>
      )}
    </div>
  );
}
