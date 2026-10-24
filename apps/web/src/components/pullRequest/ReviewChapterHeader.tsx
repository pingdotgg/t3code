import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Kbd } from "../ui/kbd";

/** Chapter navigation shared with Guide, folding its rail under the header in a narrow panel. */
export function ReviewChapterHeader({
  index,
  count,
  railOpen,
  onRailOpenChange,
  rail,
  onStep,
  keyboardHints = false,
  wideRail = false,
}: {
  index: number;
  count: number;
  railOpen: boolean;
  onRailOpenChange: (open: boolean) => void;
  rail: ReactNode;
  onStep: (delta: 1 | -1) => void;
  keyboardHints?: boolean;
  wideRail?: boolean;
}) {
  return (
    <Collapsible open={railOpen} onOpenChange={onRailOpenChange}>
      <header className="flex items-center justify-between gap-2">
        <p
          className={cn(
            "text-xs text-muted-foreground tabular-nums",
            wideRail ? "@max-[80rem]/guide:hidden" : "@max-[56rem]/guide:hidden",
          )}
        >
          Chapter {index + 1} of {count}
        </p>
        <CollapsibleTrigger
          render={
            <Button
              size="xs"
              variant="ghost-muted"
              className={wideRail ? "@min-[80rem]/guide:hidden" : "@min-[56rem]/guide:hidden"}
            />
          }
        >
          <span className="tabular-nums">
            Chapter {index + 1} of {count}
          </span>
          <ChevronDownIcon aria-hidden className={cn(railOpen && "rotate-180")} />
        </CollapsibleTrigger>
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="outline"
            aria-label="Previous chapter"
            disabled={index === 0}
            onClick={() => onStep(-1)}
          >
            <ChevronUpIcon aria-hidden />
          </Button>
          <Button
            size="icon-xs"
            variant="outline"
            aria-label="Next chapter"
            disabled={index === count - 1}
            onClick={() => onStep(1)}
          >
            <ChevronDownIcon aria-hidden />
          </Button>
          {keyboardHints ? (
            <span aria-hidden className="ml-1 flex items-center gap-0.5 @max-[30rem]/guide:hidden">
              <Kbd>J</Kbd>
              <Kbd>K</Kbd>
            </span>
          ) : null}
        </div>
      </header>
      <CollapsiblePanel
        className={wideRail ? "@min-[80rem]/guide:hidden" : "@min-[56rem]/guide:hidden"}
      >
        <div className="pt-3">{rail}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** Viewing a chapter changes the same file progress used by individual diff headers. */
export function ReviewChapterProgress({
  reviewedCount,
  fileCount,
  onSetReviewed,
  disabled = false,
}: {
  reviewedCount: number;
  fileCount: number;
  onSetReviewed: ((reviewed: boolean) => void) | null;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {onSetReviewed ? (
        <Checkbox
          id={id}
          aria-label="Mark chapter reviewed"
          disabled={disabled}
          checked={fileCount > 0 && reviewedCount === fileCount}
          onCheckedChange={(checked) => onSetReviewed(checked === true)}
        />
      ) : null}
      {onSetReviewed ? (
        <label htmlFor={id} className={disabled ? "text-muted-foreground" : "cursor-pointer"}>
          {reviewedCount} of {fileCount} files reviewed
        </label>
      ) : (
        <span>
          {reviewedCount} of {fileCount} files reviewed
        </span>
      )}
    </div>
  );
}
