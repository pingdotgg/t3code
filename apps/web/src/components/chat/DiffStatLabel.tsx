import { useGT } from "gt-react";
import { type CSSProperties, memo } from "react";
import { cn } from "~/lib/utils";

export function hasNonZeroStat(stat: { additions: number; deletions: number }): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

export function formatCompactDiffCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 999_500) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  if (value < 999_500_000) {
    const m = value / 1_000_000;
    return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}m`;
  }
  const b = value / 1_000_000_000;
  return `${b < 10 ? b.toFixed(1).replace(/\.0$/, "") : Math.round(b)}b`;
}

type DiffStat = { additions: number; deletions: number };

/**
 * Sizes the aligned columns to the largest counts in a list, so the labels in
 * every row stay aligned without the fixed 4ch of slack. Set it on the list,
 * with `data-diff-stat-columns` so the labels inside also close their gap.
 */
export function diffStatColumnsStyle(stats: ReadonlyArray<DiffStat | null>): CSSProperties {
  let additions = 2;
  let deletions = 2;
  for (const stat of stats) {
    if (!stat) continue;
    additions = Math.max(additions, formatCompactDiffCount(stat.additions).length + 1);
    deletions = Math.max(deletions, formatCompactDiffCount(stat.deletions).length + 1);
  }
  return {
    "--diff-stat-additions-width": `${additions}ch`,
    "--diff-stat-deletions-width": `${deletions}ch`,
  } as CSSProperties;
}

export const DiffStatLabel = memo(function DiffStatLabel(props: {
  additions: number;
  deletions: number;
  className?: string;
  layout?: "aligned" | "inline";
  /** The counts' typeface. Mono by default; sans where the surrounding text is sans. */
  font?: "mono" | "sans";
}) {
  const { additions, deletions, className, layout = "aligned", font = "mono" } = props;
  const fontClassName = font === "mono" ? "font-mono" : "font-sans";
  const gt = useGT();
  return (
    <span
      role="group"
      aria-label={gt("{additions} additions, {deletions} deletions", { additions, deletions })}
      className={cn(
        layout === "inline"
          ? "inline-flex items-center gap-1 tabular-nums align-middle"
          : "inline-grid grid-cols-[var(--diff-stat-additions-width,4ch)_var(--diff-stat-deletions-width,4ch)] gap-2 in-data-diff-stat-columns:gap-1.5 text-right tabular-nums align-middle",
        className,
      )}
    >
      <span aria-hidden="true" className={cn(fontClassName, "text-diff-addition-foreground")}>
        +{formatCompactDiffCount(additions)}
      </span>
      <span aria-hidden="true" className={cn(fontClassName, "text-diff-deletion-foreground")}>
        -{formatCompactDiffCount(deletions)}
      </span>
    </span>
  );
});
