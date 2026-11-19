import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useGT, useMessages } from "gt-react";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { resolvePullRequestState } from "./pullRequestPresentation";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";

import { changeRequestTermKind, type ChangeRequestTermKind } from "./changeRequestTerm";

interface CrumbsPullRequest {
  readonly url: string;
  readonly provider: string;
  readonly number: number;
  readonly repository: string;
  readonly state: "open" | "merged" | "closed";
  readonly isDraft: boolean;
}

const openNumberContextMenu = (event: ReactMouseEvent, detail: CrumbsPullRequest): void => {
  event.preventDefault();
  event.stopPropagation();
  void showPullRequestLinkContextMenu({
    url: detail.url,
    openLabel: openOnHostLabel(sourceControlClients.get(detail.provider)),
    position: { x: event.clientX, y: event.clientY },
  });
};

function BackButton({
  onBack,
  focusable,
  term,
}: {
  onBack: () => void;
  focusable: boolean;
  term: ChangeRequestTermKind;
}) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            {...(focusable ? {} : { tabIndex: -1 })}
            onClick={onBack}
            className="-ms-1.25"
            aria-label={gt(
              "Back to this thread's {term, select, mr {merge requests} cr {change requests} other {pull requests}}",
              { term },
            )}
          >
            <ArrowLeftIcon aria-hidden className="size-3.5" />
          </Button>
        }
      />
      <TooltipPopup side="top">
        {gt(
          "Back to {term, select, mr {merge requests} cr {change requests} other {pull requests}}",
          { term },
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

function NumberLink({
  detail,
  toneClassName,
  openOnHostText,
  focusable,
}: {
  detail: CrumbsPullRequest;
  toneClassName: string;
  openOnHostText: string;
  focusable: boolean;
}) {
  const gt = useGT();
  return (
    <span className={cn("inline-flex shrink-0", toneClassName)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone={null}
              {...(focusable ? {} : { tabIndex: -1 })}
              onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}
              onAuxClick={(event) => {
                if (event.button === 1) void readLocalApi()?.shell.openExternal(detail.url);
              }}
              onContextMenu={(event) => openNumberContextMenu(event, detail)}
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
              <ExternalLinkIcon aria-hidden className="size-[13px]" />
            </InlineButton>
          }
        />
        <TooltipPopup side="top">{openOnHostText}</TooltipPopup>
      </Tooltip>
    </span>
  );
}

export function PullRequestDetailCrumbs({
  detail,
  toneClassName,
  repositoryUrl,
  openOnHostText,
  onBack,
  children,
}: {
  detail: CrumbsPullRequest | null;
  toneClassName: string | null;
  repositoryUrl: string | null;
  openOnHostText: string;
  onBack: (() => void) | undefined;
  children?: ReactNode;
}) {
  const gt = useGT();
  const messages = useMessages();
  const state = detail ? resolvePullRequestState(detail, messages) : null;
  return (
    <div className="mt-2 flex min-h-6 min-w-0 flex-wrap items-center gap-1.5 pl-4 text-label text-muted-foreground">
      {detail && toneClassName && state ? (
        <>
          {onBack ? (
            <BackButton
              onBack={onBack}
              focusable
              term={changeRequestTermKind(sourceControlClients.get(detail.provider).changeRequest)}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                repositoryUrl ? (
                  <InlineButton
                    tone="muted"
                    onClick={() => void readLocalApi()?.shell.openExternal(repositoryUrl)}
                  >
                    {detail.repository}
                  </InlineButton>
                ) : (
                  <span className="shrink-0">{detail.repository}</span>
                )
              }
            />
            <TooltipPopup side="top">
              {repositoryUrl
                ? gt("Open {repository} repository", { repository: detail.repository })
                : detail.repository}
            </TooltipPopup>
          </Tooltip>
          <NumberLink
            detail={detail}
            toneClassName={toneClassName}
            openOnHostText={openOnHostText}
            focusable
          />
          {detail.state !== "open" || detail.isDraft ? (
            <Badge
              size="status"
              variant={
                detail.state === "merged"
                  ? "merged"
                  : detail.state === "closed"
                    ? "error"
                    : "secondary"
              }
            >
              <state.Icon aria-hidden />
              {state.label}
            </Badge>
          ) : null}
          {children}
        </>
      ) : null}
    </div>
  );
}
