import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { T } from "gt-react";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChangeBreakdownGrid } from "./ChangeBreakdownGrid";
import { PullRequestDiffStat } from "./pullRequestPresentation";

/**
 * The pull request's diff stat, with a hover split into code, tests, mocks, and generated files.
 * In lists the split is read on first pointer or focus intent, so rows nobody hovers cost the
 * host nothing. A view of one pull request passes `eager` so the split is ready before the hover.
 */
export function PullRequestChangeBreakdownStat({
  environmentId,
  reference,
  additions,
  deletions,
  className,
  eager = false,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  additions: number;
  deletions: number;
  className: string;
  eager?: boolean;
}) {
  const [requested, setRequested] = useState(eager);
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
          <ChangeBreakdownGrid breakdown={breakdown} total={{ additions, deletions }} />
        </TooltipPopup>
      ) : query.isPending ? (
        <TooltipPopup side="bottom">
          <T>Loading breakdown</T>
        </TooltipPopup>
      ) : null}
    </Tooltip>
  );
}

/**
 * The split shown inline, for surfaces that already sit behind a hover, such as the thread
 * details card. It reads on mount, so it costs the host a request only once the card opens.
 */
export function PullRequestChangeBreakdownRows({
  environmentId,
  reference,
  className,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  className: string;
}) {
  const query = useEnvironmentQuery(
    pullRequestEnvironment.changeBreakdown({ environmentId, input: reference }),
  );
  if (!query.data) return null;
  return (
    <div className={className}>
      <ChangeBreakdownGrid breakdown={query.data} />
    </div>
  );
}
