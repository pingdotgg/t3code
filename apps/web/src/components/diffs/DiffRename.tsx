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
    <div className="min-w-0 max-w-[min(32rem,80vw)] space-y-1.5 text-left">
      <div className="font-medium">{withChanges ? "Renamed and modified" : "Renamed"}</div>
      <div className="overflow-hidden rounded border border-border/60 font-mono leading-5 text-muted-foreground">
        <div className="grid grid-cols-[1rem_minmax(0,1fr)] gap-1 bg-error/8 px-2 py-0.5">
          <span className="select-none text-center text-error-foreground" aria-hidden="true">
            −
          </span>
          <span className="min-w-0 break-all [text-wrap:wrap]">
            <span className="sr-only">Previous path: </span>
            {parts.prefix}
            <span className="rounded-sm bg-error/20 text-error-foreground">{parts.before}</span>
            {parts.suffix}
          </span>
        </div>
        <div className="grid grid-cols-[1rem_minmax(0,1fr)] gap-1 bg-success/8 px-2 py-0.5">
          <span className="select-none text-center text-success-foreground" aria-hidden="true">
            +
          </span>
          <span className="min-w-0 break-all [text-wrap:wrap]">
            <span className="sr-only">New path: </span>
            {parts.prefix}
            <span className="rounded-sm bg-success/20 text-success-foreground">{parts.after}</span>
            {parts.suffix}
          </span>
        </div>
      </div>
    </div>
  );
}

export function DiffRenameHeader(props: DiffRenameProps) {
  const parts = changedPathParts(props.previousPath, props.path);
  const directory = parts.prefix.slice(0, parts.prefix.lastIndexOf("/") + 1);
  const prefix = parts.prefix.slice(directory.length);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} data-title data-file-path={props.path} />}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${props.withChanges ? "Renamed and modified" : "Renamed"}: ${props.previousPath} → ${props.path}`}
      >
        <span className="min-w-0 truncate">
          {prefix}
          <span className="rounded-sm bg-error/15 text-error-foreground">{parts.before}</span>
          {parts.suffix}
        </span>
        <span className="shrink-0 text-muted-foreground" aria-hidden="true">
          →
        </span>
        <span className="min-w-0 truncate">
          {prefix}
          <span className="rounded-sm bg-success/15 text-success-foreground">{parts.after}</span>
          {parts.suffix}
        </span>
        {directory ? (
          <span className="min-w-0 max-w-[40%] truncate text-muted-foreground">
            {directory.slice(0, -1)}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup>
        <DiffRenameDetails {...props} />
      </TooltipPopup>
    </Tooltip>
  );
}
