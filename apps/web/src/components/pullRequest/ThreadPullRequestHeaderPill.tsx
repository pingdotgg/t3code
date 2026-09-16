import type { ScopedThreadRef } from "@t3tools/contracts";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { GitPullRequestArrowIcon } from "lucide-react";
import { useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";

import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { cn } from "~/lib/utils";
import { requestCreatePullRequest } from "~/gitActionsBus";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";

import {
  PrStatusTooltipContent,
  prStatusIndicator,
  useLinkedThreadPullRequest,
} from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveThreadPullRequestHeaderPill } from "./threadPullRequestHeaderPill.logic";
import { useThreadPullRequestLinkContextMenu } from "./useThreadPullRequestLinkContextMenu";

/**
 * The thread's pull request, beside the git actions in the header.
 *
 * It opens the linked pull requests panel rather than the pull request itself, because the number
 * shown here is also the handle for changing which pull requests the thread carries. The host is
 * still one right-click away, along with unlinking.
 */
export function ThreadPullRequestHeaderPill({
  threadRef,
  gitCwd,
  onOpenPullRequest,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly gitCwd: string | null;
  /**
   * Opens one change request beside the thread. Used where the environment has no linked pull
   * requests panel to manage, so the click still lands on something rather than an empty surface.
   */
  readonly onOpenPullRequest?: ((number: number) => void) | undefined;
}) {
  const thread = useThreadShell(threadRef);
  const linkedStatus = useLinkedThreadPullRequest(
    threadRef.environmentId,
    thread?.linkedPullRequest,
    true,
    thread?.pullRequests,
    thread?.branchPullRequest,
  );
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(threadRef.environmentId);
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread?.pullRequests ?? [])
    : null;
  // Shares the atom the git actions control already reads, so the header asks for one status.
  const gitStatus = useEnvironmentQuery(
    gitCwd === null
      ? null
      : vcsEnvironment.status({ environmentId: threadRef.environmentId, input: { cwd: gitCwd } }),
  );
  const openPrContextMenu = useThreadPullRequestLinkContextMenu(threadRef);

  const pr = linkedStatus?.pr ?? null;
  const pullRequest = useMemo(() => {
    const number = pr?.number ?? currentLinkedPr?.number;
    const url = pr?.url ?? currentLinkedPr?.url;
    return number === undefined || url === undefined ? null : { number, url };
  }, [currentLinkedPr, pr]);
  const pill = resolveThreadPullRequestHeaderPill({
    pullRequest,
    gitStatus: gitStatus.data ?? null,
  });

  const pillNumber = pill.kind === "linked" ? pill.number : null;
  const handleClick = useCallback(() => {
    if (pillNumber === null) {
      requestCreatePullRequest();
      return;
    }
    if (!supportsMultiplePullRequests && onOpenPullRequest) {
      onOpenPullRequest(pillNumber);
      return;
    }
    useRightPanelStore.getState().open(threadRef, "pull-requests");
  }, [onOpenPullRequest, pillNumber, supportsMultiplePullRequests, threadRef]);
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      openPrContextMenu(event, {
        url: pullRequest?.url,
        providerKind: linkedStatus?.sourceControlProvider.kind,
      });
    },
    [linkedStatus, openPrContextMenu, pullRequest],
  );

  if (pill.kind === "hidden") return null;

  const status =
    pill.kind === "linked" ? prStatusIndicator(pr, linkedStatus?.sourceControlProvider) : null;
  const label = pill.kind === "create" ? "Create PR" : `#${pill.number}`;
  const tooltip =
    pill.kind === "create"
      ? "Create a pull request for this ref"
      : (status?.tooltip ?? `Pull request ${label}`);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            className={cn("shrink-0 ps-[8.5px] tabular-nums", status?.colorClass)}
            aria-label={tooltip}
            onClick={handleClick}
            {...(pill.kind === "linked" ? { onContextMenu: handleContextMenu } : {})}
          />
        }
      >
        <GitPullRequestArrowIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {status ? <PrStatusTooltipContent status={status} /> : tooltip}
      </TooltipPopup>
    </Tooltip>
  );
}
