import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { PullRequestChangeBreakdown } from "@t3tools/contracts";

const KIND_LABELS = {
  code: "Code",
  tests: "Tests",
  mocks: "Mocks",
  generated: "Generated",
  docs: "Docs",
} satisfies Record<keyof NonNullable<PullRequestChangeBreakdown>, string>;

type DiffTotals = { additions: number; deletions: number };

export function ChangeBreakdownGrid({
  breakdown,
  total,
}: {
  breakdown: NonNullable<PullRequestChangeBreakdown>;
  total?: DiffTotals;
}) {
  return (
    <div className="grid grid-cols-[auto_auto_auto] justify-start gap-x-4 gap-y-1 py-0.5 text-meta font-mono tabular-nums">
      {(Object.keys(KIND_LABELS) as Array<keyof typeof KIND_LABELS>).map((kind) => {
        const { additions, deletions } = breakdown[kind];
        return additions === 0 && deletions === 0 ? null : (
          <BreakdownRow
            key={kind}
            label={KIND_LABELS[kind]}
            additions={additions}
            deletions={deletions}
          />
        );
      })}
      {total ? (
        <>
          <div className="col-span-3 border-t border-border" />
          <BreakdownRow label="Total" additions={total.additions} deletions={total.deletions} />
        </>
      ) : null}
    </div>
  );
}

function BreakdownRow({ label, additions, deletions }: DiffTotals & { label: string }) {
  return (
    <>
      <span className="font-sans">{label}</span>
      <span className="text-right text-diff-addition-foreground">
        +{formatDiffCount(additions)}
      </span>
      <span className="text-right text-diff-deletion-foreground">
        -{formatDiffCount(deletions)}
      </span>
    </>
  );
}
