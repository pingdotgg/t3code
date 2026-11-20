import { ChevronDown, Ellipsis, Plus } from "lucide-react";

const iconButton =
  "grid size-5 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg";

export function ProjectHeader({
  name,
  open,
  onToggle,
  onMenu,
  onAdd,
}: {
  name: string;
  open: boolean;
  onToggle: () => void;
  onMenu?: () => void;
  /** Absent until something can be added under the project, which then shows the button. */
  onAdd?: () => void;
}) {
  return (
    <div className="group flex min-w-0 items-center gap-1 rounded-md px-2 py-1 hover:bg-hover focus-within:bg-hover">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left"
      >
        <span className="grid size-[18px] shrink-0 place-items-center rounded-full border-2 border-sky-400 text-[9px] font-bold text-sky-400">
          {Array.from(name)[0]?.toUpperCase() ?? "?"}
        </span>
        <span className="min-w-0 truncate font-bold">{name}</span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-muted transition-transform ${open ? "" : "-rotate-90"}`}
          aria-hidden
        />
      </button>
      {onMenu && (
        <button type="button" aria-label={`${name} menu`} onClick={onMenu} className={iconButton}>
          <Ellipsis className="size-4" />
        </button>
      )}
      {onAdd && (
        <button
          type="button"
          aria-label={`Add under ${name}`}
          onClick={onAdd}
          className={iconButton}
        >
          <Plus className="size-4" />
        </button>
      )}
    </div>
  );
}
