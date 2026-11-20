import { X } from "lucide-react";
import type { ReactNode } from "react";

export const TAB =
  "relative flex h-9 items-center gap-1.5 border-r border-line px-3 text-[12px] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5";
export const LIT = "bg-bg text-fg after:bg-fg";
export const DIM = "text-muted hover:text-fg";

/** A tab with a close button, which the files, the pages, and the agent tabs all draw. */
export function ClosableTab({
  shown,
  icon,
  label,
  onSelect,
  onClose,
}: {
  shown: boolean;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div data-testid="main-tab" data-active={shown} className={`${TAB} ${shown ? LIT : DIM}`}>
      <button
        type="button"
        role="tab"
        aria-selected={shown}
        onClick={onSelect}
        className="flex items-center gap-1.5"
      >
        {icon}
        <span className="max-w-40 truncate">{label}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${label}`}
        onClick={onClose}
        className="grid size-4 place-items-center rounded-sm hover:bg-hover"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}
