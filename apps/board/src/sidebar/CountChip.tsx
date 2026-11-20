import { ChevronDown, GitFork } from "lucide-react";

/** A child count, a green status dot with its own count, and a chevron. */
export function CountChip({
  label,
  active,
  open,
}: {
  label: string;
  /** Children that are working now. The dot and its count show only when above zero. */
  active: number;
  open?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-px text-[11px] leading-4 font-semibold text-fg">
      <GitFork className="size-3 text-muted" aria-hidden />
      {label}
      {active > 0 && (
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />
          {active}
        </span>
      )}
      <ChevronDown
        className={`size-3 text-muted transition-transform ${open === false ? "-rotate-90" : ""}`}
        aria-hidden
      />
    </span>
  );
}
