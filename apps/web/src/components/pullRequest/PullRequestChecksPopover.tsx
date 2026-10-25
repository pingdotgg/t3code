import type * as React from "react";
import type {
  EnvironmentId,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { groupPullRequestChecks } from "./pullRequestDetail.logic";
import {
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  pullRequestChecksStatePresentation,
  summarizePullRequestChecks,
} from "./pullRequestPresentation";

// Fetch only on open to avoid per-row requests.
function LazyChecksBody({
  environmentId,
  reference,
  threadRef,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  threadRef: ScopedThreadRef | null;
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
  return <ChecksBody checks={detailQuery.data.checks} threadRef={threadRef} />;
}

function ChecksBody({
  checks,
  threadRef,
}: {
  checks: ReadonlyArray<PullRequestCheck>;
  threadRef: ScopedThreadRef | null;
}) {
  const openLink = useOpenLink(threadRef);
  const [showAll, setShowAll] = useState(false);
  const { attention, running, completed } = groupPullRequestChecks(checks);
  const canCollapse = attention.length + running.length > 0 && completed.length > 0;
  const visibleChecks = [...attention, ...running, ...(showAll || !canCollapse ? completed : [])];
  const hasDetails = visibleChecks.some((check) => check.url !== null);
  if (checks.length === 0) {
    return <p className="text-muted-foreground text-xs">No checks reported</p>;
  }
  return (
    <>
      <ScrollArea className="-me-3 w-auto max-h-64">
        <ul
          className={cn(
            "grid gap-x-2 gap-y-1 pe-3",
            hasDetails
              ? "grid-cols-[auto_minmax(0,1fr)_auto_auto]"
              : "grid-cols-[auto_minmax(0,1fr)_auto]",
          )}
        >
          {visibleChecks.map((check, index) => (
            <li
              key={`${index}:${check.name}`}
              className="col-span-full grid grid-cols-subgrid items-center text-xs"
            >
              <PullRequestCheckStatusIcon status={check.status} />
              <Tooltip>
                <TooltipTrigger render={<span className="min-w-0 truncate">{check.name}</span>} />
                <TooltipPopup side="top">{check.description ?? check.name}</TooltipPopup>
              </Tooltip>
              <span className="justify-self-end whitespace-nowrap text-muted-foreground">
                {pullRequestCheckStatusLabel(check)}
              </span>
              {check.url === null ? null : (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => {
                    if (!check.url) return;
                    void openLink(check.url).catch((error: unknown) => {
                      console.error(error);
                      toastManager.add({ type: "error", title: "Unable to open check details" });
                    });
                  }}
                >
                  Details
                </button>
              )}
            </li>
          ))}
        </ul>
      </ScrollArea>
      {canCollapse ? (
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </>
  );
}

export function PullRequestChecksPopover({
  checksState,
  checks,
  stale = false,
  environmentId,
  reference,
  threadRef = null,
  variant = "icon",
  className,
  render,
}: {
  checksState: PullRequestChecksState;
  checks?: ReadonlyArray<PullRequestCheck>;
  stale?: boolean;
  environmentId?: EnvironmentId;
  reference?: PullRequestRef;
  threadRef?: ScopedThreadRef | null;
  variant?: "icon" | "count";
  className?: string;
  render?: React.ReactElement;
}) {
  const presentation = pullRequestChecksStatePresentation(checksState);
  const incompleteCount =
    checks?.filter((check) => check.status === "pending" || check.status === "action-required")
      .length ?? 0;
  const failedCount =
    checks?.filter((check) => check.status === "failure" || check.status === "cancelled").length ??
    0;
  const summary = checks === undefined || stale ? null : summarizePullRequestChecks(checks);
  return (
    <Popover>
      <PopoverTrigger
        nativeButton={variant === "count"}
        aria-label={
          variant === "count"
            ? `Open checks: ${summary ?? presentation.label}`
            : `Checks: ${presentation.label}`
        }
        render={
          variant === "count" ? (
            (render ?? <Button variant="ghost" size="sm" className={className} />)
          ) : (
            <span
              role="button"
              tabIndex={0}
              className={cn("inline-flex shrink-0 cursor-pointer items-center", className)}
            />
          )
        }
        onClick={(event) => event.stopPropagation()}
      >
        <presentation.Icon aria-hidden className={cn("size-3.5", presentation.toneClassName)} />
        {variant === "count" ? (
          <>
            {checks !== undefined && incompleteCount > 0 ? (
              <span className="tabular-nums">
                {checks.length - incompleteCount}/{checks.length} checks
              </span>
            ) : failedCount > 0 ? (
              <span className="tabular-nums">{failedCount} failed</span>
            ) : null}
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" width="md" side="bottom">
        <p className="mb-2 font-medium text-sm">{presentation.label}</p>
        {summary === null ? null : <p className="mb-2 text-muted-foreground text-xs">{summary}</p>}
        {stale ? (
          <p className="text-muted-foreground text-xs">
            Check details are out of date. Refresh the pull request to update them.
          </p>
        ) : checks !== undefined ? (
          <ChecksBody checks={checks} threadRef={threadRef} />
        ) : environmentId !== undefined && reference !== undefined ? (
          <LazyChecksBody
            environmentId={environmentId}
            reference={reference}
            threadRef={threadRef}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
