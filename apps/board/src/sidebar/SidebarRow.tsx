import type { ReactNode } from "react";

/** Left padding of a row at depth 0, and the step each nesting level adds. */
const BASE_INDENT_PX = 8;
const INDENT_STEP_PX = 14;

export function SidebarRow({
  depth = 0,
  icon,
  title,
  trailing,
  onClick,
  label,
  selected,
}: {
  depth?: number;
  icon: ReactNode;
  title: string;
  /** Status icons, pinned to the right while the title truncates. */
  trailing?: ReactNode;
  onClick?: () => void;
  label?: string;
  selected?: boolean;
}) {
  return (
    <div
      className={`group flex min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-fg hover:bg-hover focus-within:bg-hover ${selected ? "bg-hover" : ""}`}
      style={{ paddingLeft: BASE_INDENT_PX + depth * INDENT_STEP_PX }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={label ?? title}
        aria-current={selected ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left"
      >
        <span className="grid size-4 shrink-0 place-items-center text-muted">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      {trailing && (
        <span className="flex shrink-0 items-center gap-1.5 text-muted">{trailing}</span>
      )}
    </div>
  );
}
