import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { T, useGT } from "gt-react";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";

import { changeRequestTermKind } from "./changeRequestTerm";

interface LinkedPullRequest {
  readonly url: string;
  readonly provider: string;
  readonly number: number;
  readonly repository: string;
}

const openNumberContextMenu = (event: ReactMouseEvent, detail: LinkedPullRequest): void => {
  event.preventDefault();
  event.stopPropagation();
  void showPullRequestLinkContextMenu({
    url: detail.url,
    openLabel: openOnHostLabel(sourceControlClients.get(detail.provider)),
    position: { x: event.clientX, y: event.clientY },
  });
};

export function PullRequestBackButton({ onBack }: { onBack: () => void }) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            onClick={onBack}
            className="-ml-1.5 shrink-0"
            aria-label={gt("Back to this thread's pull requests")}
          >
            <ArrowLeftIcon aria-hidden className="size-3.5" />
          </Button>
        }
      />
      <TooltipPopup side="top">
        <T>Back to pull requests</T>
      </TooltipPopup>
    </Tooltip>
  );
}

/** The number and an arrow in the pull request's state colour; opens it on the host. */
export function PullRequestNumberLink({
  detail,
  toneClassName,
  openOnHostText,
}: {
  detail: LinkedPullRequest;
  toneClassName: string | null;
  openOnHostText: string;
}) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}
            onAuxClick={(event) => {
              if (event.button === 1) void readLocalApi()?.shell.openExternal(detail.url);
            }}
            onContextMenu={(event) => openNumberContextMenu(event, detail)}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center gap-1 tabular-nums underline-offset-2 hover:underline",
              toneClassName,
            )}
            aria-label={gt(
              "Open {term, select, mr {merge request} cr {change request} other {pull request}} #{number} on host",
              {
                term: changeRequestTermKind(
                  sourceControlClients.get(detail.provider).changeRequest,
                ),
                number: detail.number,
              },
            )}
          >
            #{detail.number}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </button>
        }
      />
      <TooltipPopup side="top">{openOnHostText}</TooltipPopup>
    </Tooltip>
  );
}

export function PullRequestRepositoryLink({
  repository,
  repositoryUrl,
}: {
  repository: string;
  repositoryUrl: string | null;
}) {
  const gt = useGT();
  if (repositoryUrl === null) return <span className="min-w-0 truncate">{repository}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => void readLocalApi()?.shell.openExternal(repositoryUrl)}
            className="min-w-0 cursor-pointer truncate text-left underline-offset-2 hover:underline"
          >
            {repository}
          </button>
        }
      />
      <TooltipPopup side="top">{gt("Open {repository} repository", { repository })}</TooltipPopup>
    </Tooltip>
  );
}
