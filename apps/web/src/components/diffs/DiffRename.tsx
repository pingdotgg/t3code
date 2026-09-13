import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { changedPathParts } from "./diffFileTree.logic";

interface DiffRenameProps {
  readonly previousPath: string;
  readonly path: string;
  readonly withChanges?: boolean;
}

export function DiffRenameDetails({ previousPath, path, withChanges }: DiffRenameProps) {
  const parts = changedPathParts(previousPath, path);
  return (
    <div className="max-w-[min(32rem,80vw)] space-y-1 text-left">
      <div className="font-medium">{withChanges ? "Renamed and modified" : "Renamed"}</div>
      <div className="break-all font-mono text-muted-foreground">
        <span className="mr-2 text-error-foreground" aria-hidden="true">
          −
        </span>
        {parts.prefix}
        <span className="rounded-sm bg-error/15 text-error-foreground">{parts.before}</span>
        {parts.suffix}
      </div>
      <div className="break-all font-mono text-muted-foreground">
        <span className="mr-2 text-success-foreground" aria-hidden="true">
          +
        </span>
        {parts.prefix}
        <span className="rounded-sm bg-success/15 text-success-foreground">{parts.after}</span>
        {parts.suffix}
      </div>
    </div>
  );
}

export function DiffRenameBadge(props: DiffRenameProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        className="ml-1 shrink-0 rounded bg-warning/10 px-1 py-0.5 text-[10px] text-warning-foreground"
        aria-label={`${props.withChanges ? "Renamed and modified" : "Renamed"}: ${props.previousPath} → ${props.path}`}
      >
        Renamed
      </TooltipTrigger>
      <TooltipPopup>
        <DiffRenameDetails {...props} />
      </TooltipPopup>
    </Tooltip>
  );
}
