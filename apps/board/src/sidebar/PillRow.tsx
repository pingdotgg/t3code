import { ChevronRight } from "lucide-react";

/** Stands for items that are hidden, with their count and a chevron. */
export function PillRow({
  count,
  label,
  onClick,
}: {
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="my-1 flex w-full items-center gap-2 rounded-lg border border-line px-2 py-1 text-left text-muted hover:bg-hover hover:text-fg"
    >
      <span className="grid size-4 shrink-0 place-items-center rounded-full border border-line text-[10px] font-semibold text-fg">
        {count}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronRight className="size-3.5 shrink-0" aria-hidden />
    </button>
  );
}
