import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { PullRequestChangeBreakdown } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";

const KIND_LABELS = {
  code: msg("Code", { $context: "kind of changed file" }),
  tests: msg("Tests", { $context: "kind of changed file" }),
  mocks: msg("Mocks", { $context: "kind of changed file" }),
  generated: msg("Generated", { $context: "kind of changed file" }),
  docs: msg("Docs", { $context: "kind of changed file" }),
} satisfies Record<keyof NonNullable<PullRequestChangeBreakdown>, string>;

type DiffTotals = { additions: number; deletions: number };

export function ChangeBreakdownGrid({
  breakdown,
  total,
}: {
  breakdown: NonNullable<PullRequestChangeBreakdown>;
  total?: DiffTotals;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <div className="grid grid-cols-[auto_auto_auto] justify-start gap-x-4 gap-y-1 py-0.5 font-mono tabular-nums">
      {(Object.keys(KIND_LABELS) as Array<keyof typeof KIND_LABELS>).map((kind) => {
        const { additions, deletions } = breakdown[kind];
        return additions === 0 && deletions === 0 ? null : (
          <BreakdownRow
            key={kind}
            label={m(KIND_LABELS[kind])}
            additions={additions}
            deletions={deletions}
          />
        );
      })}
      {total ? (
        <>
          <div className="col-span-3 border-t border-border" />
          <BreakdownRow
            label={gt("Total", { $context: "sum of changed lines" })}
            additions={total.additions}
            deletions={total.deletions}
          />
        </>
      ) : null}
    </div>
  );
}

function BreakdownRow({ label, additions, deletions }: DiffTotals & { label: string }) {
  return (
    <>
      <span className="font-sans">{label}</span>
      <span dir="ltr" className="text-end text-diff-addition-foreground">
        +{formatDiffCount(additions)}
      </span>
      <span dir="ltr" className="text-end text-diff-deletion">
        -{formatDiffCount(deletions)}
      </span>
    </>
  );
}
