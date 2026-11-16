import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { Button } from "../ui/button";

export function UsageLimitLayoutControls({
  label,
  index,
  count,
  hidden,
  onMove,
  onToggleVisibility,
}: {
  readonly label: string;
  readonly index: number;
  readonly count: number;
  readonly hidden: boolean;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onToggleVisibility: () => void;
}) {
  const visibilityLabel = `${hidden ? "Show" : "Hide"} ${label}`;
  return (
    <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within/limit-row:opacity-100 group-hover/limit-row:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100">
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label={`Move ${label} up`}
          title={`Move ${label} up`}
          aria-disabled={index === 0}
          onClick={() => {
            if (index > 0) onMove(-1);
          }}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label={`Move ${label} down`}
          title={`Move ${label} down`}
          aria-disabled={index === count - 1}
          onClick={() => {
            if (index < count - 1) onMove(1);
          }}
        >
          <ArrowDownIcon />
        </Button>
      </div>
      <Button
        variant="ghost-muted"
        size="xs"
        aria-label={visibilityLabel}
        title={visibilityLabel}
        onClick={onToggleVisibility}
      >
        {hidden ? "Show" : "Hide"}
      </Button>
    </div>
  );
}
