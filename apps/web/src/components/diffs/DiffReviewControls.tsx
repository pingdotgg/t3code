import { FileIcon } from "lucide-react";

import { Checkbox } from "../ui/checkbox";
import { Toggle } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const withShortcut = (label: string, shortcut: string | null) =>
  shortcut ? `${label} (${shortcut})` : label;

/** Outlines the file header under the review cursor; render it in the header prefix. */
export function DiffCursorOutline() {
  return (
    // The sticky header is the nearest positioned box, so this outlines the whole header.
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 ring-1 ring-primary/70 ring-inset"
    />
  );
}

export function DiffViewedToggle({
  filePath,
  viewed,
  stale = false,
  shortcutLabel,
  onViewedChange,
}: {
  filePath: string;
  viewed: boolean;
  /** The file changed after it was marked viewed. */
  stale?: boolean;
  shortcutLabel: string | null;
  onViewedChange: (viewed: boolean, extendRange: boolean) => void;
}) {
  const action = withShortcut(viewed ? "Mark as not viewed" : "Mark as viewed", shortcutLabel);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <label
            data-viewed-toggle=""
            className="flex w-18 shrink-0 cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <Checkbox
          aria-label={`${stale ? "Changed" : "Viewed"} ${filePath}`}
          checked={viewed}
          onCheckedChange={(next, details) =>
            onViewedChange(
              next === true,
              "shiftKey" in details.event && details.event.shiftKey === true,
            )
          }
        />
        {stale ? (
          <span className="text-warning-foreground">Changed</span>
        ) : (
          <span className="@max-xs:hidden">Viewed</span>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {stale ? `This file has been pushed to since you marked it viewed. ${action}` : action}
      </TooltipPopup>
    </Tooltip>
  );
}

export function DiffSingleFileToggle({
  singleFile,
  shortcutLabel,
  onToggle,
}: {
  singleFile: boolean;
  shortcutLabel: string | null;
  onToggle: () => void;
}) {
  const label = singleFile ? "Show all files" : "Show one file at a time";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={label}
            variant="ghost"
            size="sm"
            pressed={singleFile}
            onPressedChange={onToggle}
          />
        }
      >
        <FileIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{withShortcut(label, shortcutLabel)}</TooltipPopup>
    </Tooltip>
  );
}
