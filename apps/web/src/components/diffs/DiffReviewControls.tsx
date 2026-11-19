import { T, useGT, Var } from "gt-react";
import { CheckIcon, FileIcon } from "lucide-react";

import { Checkbox } from "../ui/checkbox";
import { Toggle } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useIsDiffReviewCursorFile } from "./useDiffReviewKeyboard";

/** The viewed count; once every file is viewed it reads as a finished review. */
export function DiffViewedCount({ viewed, total }: { viewed: number; total: number }) {
  if (total === 0 || viewed < total) {
    return (
      <>
        {viewed} / {total}
      </>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-success-foreground">
      <CheckIcon aria-hidden className="size-3.5" />
      <T>
        All <Var>{total}</Var>
      </T>
    </span>
  );
}

/** Outlines the file header under the review cursor; render it in the header prefix. */
export function DiffCursorOutline({ filePath }: { filePath: string }) {
  if (!useIsDiffReviewCursorFile(filePath)) return null;
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
  const gt = useGT();
  const action = viewed
    ? shortcutLabel
      ? gt("Mark as not viewed ({shortcut})", { shortcut: shortcutLabel })
      : gt("Mark as not viewed")
    : shortcutLabel
      ? gt("Mark as viewed ({shortcut})", { shortcut: shortcutLabel })
      : gt("Mark as viewed");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <label
            data-viewed-toggle=""
            className="flex h-8 w-18 shrink-0 cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <Checkbox
          aria-label={
            stale
              ? gt("Changed {path}", { path: filePath, $context: "file changed since viewed" })
              : gt("Viewed {path}", { path: filePath, $context: "file marked as viewed" })
          }
          checked={viewed}
          onCheckedChange={(next, details) =>
            onViewedChange(
              next === true,
              "shiftKey" in details.event && details.event.shiftKey === true,
            )
          }
        />
        {stale ? (
          <span className="text-warning-foreground">
            <T context="file changed since viewed">Changed</T>
          </span>
        ) : (
          <span className="@max-xs:hidden">
            <T context="file marked as viewed">Viewed</T>
          </span>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {stale
          ? `${gt("This file has been pushed to since you marked it viewed.")} ${action}`
          : action}
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
  const gt = useGT();
  const label = singleFile ? gt("Show all files") : gt("Show one file at a time");
  const tooltip = shortcutLabel
    ? singleFile
      ? gt("Show all files ({shortcut})", { shortcut: shortcutLabel })
      : gt("Show one file at a time ({shortcut})", { shortcut: shortcutLabel })
    : label;
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
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
