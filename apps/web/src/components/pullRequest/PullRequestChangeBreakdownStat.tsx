import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { EnvironmentId, PullRequestChangeBreakdown, PullRequestRef } from "@t3tools/contracts";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestDiffStat } from "./pullRequestPresentation";

const KIND_LABELS = {
  code: "Code",
  tests: "Tests",
  mocks: "Mocks",
  generated: "Generated",
} satisfies Record<keyof NonNullable<PullRequestChangeBreakdown>, string>;

/**
 * The pull request's diff stat, with a hover split into code, tests, mocks, and generated files.
 * The split is read on first pointer or focus intent, so a page nobody hovers costs the host
 * nothing.
 */
export function PullRequestChangeBreakdownStat({
  environmentId,
  reference,
  additions,
  deletions,
  className,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  additions: number;
  deletions: number;
  className: string;
}) {
  const [requested, setRequested] = useState(false);
  const query = useEnvironmentQuery(
    requested ? pullRequestEnvironment.changeBreakdown({ environmentId, input: reference }) : null,
  );
  const breakdown = query.data;
  if (additions === 0 && deletions === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        onPointerEnter={() => setRequested(true)}
        onFocus={() => setRequested(true)}
        render={
          <span className="inline-flex">
            <PullRequestDiffStat
              additions={additions}
              deletions={deletions}
              className={className}
            />
          </span>
        }
      />
      {breakdown ? (
        <TooltipPopup side="bottom">
          <div className="grid grid-cols-[auto_auto_auto] gap-x-4 gap-y-1 py-0.5 font-mono tabular-nums">
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
            <div className="col-span-3 border-t border-border" />
            <BreakdownRow label="Total" additions={additions} deletions={deletions} />
          </div>
        </TooltipPopup>
      ) : query.isPending ? (
        <TooltipPopup side="bottom">Loading breakdown</TooltipPopup>
      ) : null}
    </Tooltip>
  );
}

function BreakdownRow({
  label,
  additions,
  deletions,
}: {
  label: string;
  additions: number;
  deletions: number;
}) {
  return (
    <>
      <span className="font-sans">{label}</span>
      <span className="text-right text-diff-addition-foreground">
        +{formatDiffCount(additions)}
      </span>
      <span className="text-right text-diff-deletion">-{formatDiffCount(deletions)}</span>
    </>
  );
}
