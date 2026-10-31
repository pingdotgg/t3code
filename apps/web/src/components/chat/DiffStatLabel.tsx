import { memo } from "react";
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

export const DiffStatLabel = memo(function DiffStatLabel(props: {
  additions: number;
  deletions: number;
  className?: string;
  layout?: "aligned" | "inline";
  font?: "sans" | "mono";
}) {
  const { additions, deletions, className, layout = "aligned", font = "sans" } = props;
  return (
    <span
      role="group"
      aria-label={`${additions} additions, ${deletions} deletions`}
      className={cn(
        layout === "inline"
          ? "inline-flex items-center gap-1 tabular-nums align-middle"
          : "inline-grid grid-cols-[4ch_4ch] gap-2 text-right tabular-nums align-middle",
        font === "mono" ? "font-mono font-normal" : "font-sans font-medium",
        className,
      )}
    >
      <span aria-hidden="true" className="text-diff-addition-foreground">
        +{formatCompactDiffCount(additions)}
      </span>
      <span aria-hidden="true" className="text-diff-deletion-foreground">
        -{formatCompactDiffCount(deletions)}
      </span>
    </span>
  );
});

type DiffBlock = "addition" | "deletion" | "empty";
// Blocks never reorder, so each slot keeps its own key.
const DIFF_BLOCK_SLOTS = ["first", "second", "third", "fourth", "fifth"] as const;

/** Five blocks: how many fill grows with the size of the change, split by its mix. */
function diffStatBlocks(additions: number, deletions: number): DiffBlock[] {
  const total = additions + deletions;
  const filled =
    total === 0 ? 0 : total < 5 ? 1 : total < 20 ? 2 : total < 100 ? 3 : total < 1000 ? 4 : 5;
  let additionBlocks = total === 0 ? 0 : Math.round((filled * additions) / total);
  if (additions > 0 && additionBlocks === 0) additionBlocks = 1;
  if (deletions > 0 && additionBlocks === filled && filled > 1) additionBlocks = filled - 1;
  const deletionBlocks = deletions > 0 ? filled - additionBlocks : 0;
  return DIFF_BLOCK_SLOTS.map((_, index) =>
    index < additionBlocks
      ? "addition"
      : index < additionBlocks + deletionBlocks
        ? "deletion"
        : "empty",
  );
}

const fullCount = new Intl.NumberFormat("en-US");

/** The working bar and turn fold diff: full counts with separators and five blocks. */
export const DiffStatBlocks = memo(function DiffStatBlocks(props: {
  additions: number;
  deletions: number;
}) {
  const { additions, deletions } = props;
  return (
    <span
      role="group"
      aria-label={`${additions} additions, ${deletions} deletions`}
      className="inline-flex shrink-0 items-center gap-2.5 text-meta tabular-nums"
    >
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        <span className="text-diff-addition-foreground">+{fullCount.format(additions)}</span>
        <span className="text-diff-deletion-foreground">−{fullCount.format(deletions)}</span>
      </span>
      <span aria-hidden="true" className="inline-flex items-center gap-0.5">
        {diffStatBlocks(additions, deletions).map((block, index) => (
          <span
            key={DIFF_BLOCK_SLOTS[index]}
            className={cn(
              "size-[7px] rounded-xs",
              block === "addition"
                ? "bg-diff-addition-foreground"
                : block === "deletion"
                  ? "bg-diff-deletion-foreground"
                  : "bg-(--detail-separator)",
            )}
          />
        ))}
      </span>
    </span>
  );
});
