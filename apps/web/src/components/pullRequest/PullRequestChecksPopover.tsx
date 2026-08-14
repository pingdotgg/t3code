import type {
  EnvironmentId,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestRef,
} from "@t3tools/contracts";

import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  pullRequestChecksStatePresentation,
  summarizePullRequestChecks,
} from "./pullRequestPresentation";

/**
 * The checks behind the rollup, for a row that only carries the rollup. Mounted by the popup, so
 * the read starts when somebody opens it rather than once per row of a listing — the detail read
 * is a request per pull request, and a page of them at rest would be a hundred.
 */
function LazyChecksBody({
  environmentId,
  reference,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
}) {
  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  if (detailQuery.error !== null) {
    return <p className="text-muted-foreground text-xs">{detailQuery.error}</p>;
  }
  if (detailQuery.data === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {detailQuery.isPending ? "Loading checks…" : "No checks reported"}
      </p>
    );
  }
  return <ChecksBody checks={detailQuery.data.checks} />;
}

function ChecksBody({ checks }: { checks: ReadonlyArray<PullRequestCheck> }) {
  if (checks.length === 0) {
    return <p className="text-muted-foreground text-xs">No checks reported</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {/* Keyed by position as well as by name: the host is the one that decides how many runs
          share a name, and a repeated key is a rendering fault rather than a wrong list. */}
      {checks.map((check, index) => (
        <li key={`${index}:${check.name}`} className="flex items-center gap-2 text-xs">
          <PullRequestCheckStatusIcon status={check.status} />
          <span className="min-w-0 flex-1 truncate" title={check.description ?? check.name}>
            {check.name}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {pullRequestCheckStatusLabel(check.status)}
          </span>
          {check.url === null ? null : (
            <button
              type="button"
              className="shrink-0 text-primary hover:underline"
              onClick={() => void readLocalApi()?.shell.openExternal(check.url ?? "")}
            >
              Details
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The checks indicator and what it opens, in both places a change request is shown: a listing
 * row, which knows only the rollup, and the detail header, which is already holding every check.
 *
 * `checks` decides between the two. Given them, nothing is read; without them, the popup reads
 * the detail itself, which is why the row must also say which environment it came from.
 */
export function PullRequestChecksPopover({
  checksState,
  checks,
  environmentId,
  reference,
  className,
}: {
  checksState: PullRequestChecksState;
  /** The checks already in hand, for the detail header. Absent on a listing row. */
  checks?: ReadonlyArray<PullRequestCheck>;
  environmentId?: EnvironmentId;
  reference?: PullRequestRef;
  className?: string;
}) {
  const presentation = pullRequestChecksStatePresentation(checksState);
  // Counts beat the rollup's own wording where they are known, the way GitHub's own header reads.
  const summary = checks === undefined ? null : summarizePullRequestChecks(checks);
  return (
    <Popover>
      {/* A listing row is itself a button, so the trigger renders as a span: a nested button is
          not valid inside one. The click is stopped here so opening the checks does not also
          select the row it sits on. */}
      <PopoverTrigger
        render={
          <span
            role="button"
            tabIndex={0}
            aria-label={`Checks: ${presentation.label}`}
            className={cn("inline-flex shrink-0 cursor-pointer items-center", className)}
          />
        }
        onClick={(event) => event.stopPropagation()}
      >
        <presentation.Icon aria-hidden className={cn("size-3.5", presentation.toneClassName)} />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80 max-w-full" side="bottom">
        <p className="mb-2 font-medium text-sm">{presentation.label}</p>
        {summary === null ? null : <p className="mb-2 text-muted-foreground text-xs">{summary}</p>}
        {checks !== undefined ? (
          <ChecksBody checks={checks} />
        ) : environmentId !== undefined && reference !== undefined ? (
          <LazyChecksBody environmentId={environmentId} reference={reference} />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
