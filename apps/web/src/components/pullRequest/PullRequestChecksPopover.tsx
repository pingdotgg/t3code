import type * as React from "react";
import type {
  EnvironmentId,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { m } from "~/i18n/messages";
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
  const gt = useGT();
  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
    useMessages(),
  );
  if (detailQuery.error !== null) {
    return <p className="text-muted-foreground text-xs">{detailQuery.error}</p>;
  }
  if (detailQuery.data === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {detailQuery.isPending ? gt("Loading checks…") : gt("No checks reported")}
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
  const gt = useGT();
  const resolve = useMessages();
  const openLink = useOpenLink(threadRef);
  const [showAll, setShowAll] = useState(false);
  const { attention, running, completed } = groupPullRequestChecks(checks);
  const canCollapse = attention.length + running.length > 0 && completed.length > 0;
  const visibleChecks = [...attention, ...running, ...(showAll || !canCollapse ? completed : [])];
  const hasDetails = visibleChecks.some((check) => check.url !== null);
  if (checks.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        <T>No checks reported</T>
      </p>
    );
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
          {visibleChecks.map(
            (check, index) => (
              /* oxlint-disable react/no-array-index-key -- Check names can repeat; these status rows have no local state. */ <li
                key={`${index}:${check.name}`}
                className="col-span-full grid grid-cols-subgrid items-center text-xs"
              >
                <PullRequestCheckStatusIcon status={check.status} />
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 truncate">{check.name}</span>} />
                  <TooltipPopup side="top">{check.description ?? check.name}</TooltipPopup>
                </Tooltip>
                <span className="justify-self-end whitespace-nowrap text-muted-foreground">
                  {pullRequestCheckStatusLabel(check, resolve)}
                </span>
                {check.url === null ? null : (
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => {
                      if (!check.url) return;
                      void openLink(check.url).catch((error: unknown) => {
                        console.error(error);
                        toastManager.add({
                          type: "error",
                          title: m(msg("Unable to open check details")),
                        });
                      });
                    }}
                  >
                    <T>Details</T>
                  </button>
                )}
              </li>
            ) /* oxlint-enable react/no-array-index-key */,
          )}
        </ul>
      </ScrollArea>
      {canCollapse ? (
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? gt("Show less") : gt("Show all")}
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
  const gt = useGT();
  const resolve = useMessages();
  const presentation = pullRequestChecksStatePresentation(checksState, resolve);
  const incompleteCount =
    checks?.filter((check) => check.status === "pending" || check.status === "action-required")
      .length ?? 0;
  const failedCount =
    checks?.filter((check) => check.status === "failure" || check.status === "cancelled").length ??
    0;
  const summary =
    checks === undefined || stale ? null : summarizePullRequestChecks(checks, resolve);
  return (
    <Popover>
      <PopoverTrigger
        nativeButton={variant === "count"}
        aria-label={
          variant === "count"
            ? gt("Open checks: {summary}", { summary: summary ?? presentation.label })
            : gt("Checks: {summary}", { summary: presentation.label })
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
              // Clip the second line so "checks" disappears whole when the count must shrink.
              <span className="h-lh min-w-0 overflow-hidden text-left whitespace-normal tabular-nums">
                <T>
                  <span className="whitespace-nowrap">
                    <Var>{checks.length - incompleteCount}</Var>/<Var>{checks.length}</Var>
                  </span>{" "}
                  checks
                </T>
              </span>
            ) : failedCount > 0 ? (
              <span className="min-w-0 truncate tabular-nums">
                {gt("{count, plural, one {{count} failed} other {{count} failed}}", {
                  count: failedCount,
                })}
              </span>
            ) : null}
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" width="md" side="bottom">
        <p className="mb-2 font-medium text-sm">{presentation.label}</p>
        {summary === null ? null : <p className="mb-2 text-muted-foreground text-xs">{summary}</p>}
        {stale ? (
          <p className="text-muted-foreground text-xs">
            <T>Check details are out of date. Refresh the pull request to update them.</T>
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
