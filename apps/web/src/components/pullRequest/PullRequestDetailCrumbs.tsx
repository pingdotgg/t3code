import type { ScopedThreadRef } from "@t3tools/contracts";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useGT, useMessages } from "gt-react";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { resolvePullRequestState } from "./pullRequestPresentation";
import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
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
    source: contextMenuSourceOf(event),
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
    <SharedTooltipTrigger
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
      label={gt(
        "Back to {term, select, mr {merge requests} cr {change requests} other {pull requests}}",
        { term },
      )}
    />
  );
}

function NumberLink({
  detail,
  threadRef,
  toneClassName,
  openOnHostText,
  focusable,
}: {
  detail: CrumbsPullRequest;
  threadRef: ScopedThreadRef | null;
  toneClassName: string;
  openOnHostText: string;
  focusable: boolean;
}) {
  const gt = useGT();
  const openLink = useOpenLink(threadRef);
  return (
    <span className={cn("inline-flex shrink-0", toneClassName)}>
      <SharedTooltipTrigger
        render={
          <InlineButton
            tone={null}
            {...(focusable ? {} : { tabIndex: -1 })}
            onClick={(event) => void openLink(detail.url, { event }).catch(console.error)}
            onAuxClick={(event) => {
              if (event.button === 1) void openLink(detail.url, { event }).catch(console.error);
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
        label={openOnHostText}
      />
    </span>
  );
}

export function PullRequestDetailCrumbs({
  detail,
  threadRef,
  toneClassName,
  repositoryUrl,
  openOnHostText,
  onBack,
  children,
}: {
  detail: CrumbsPullRequest | null;
  threadRef: ScopedThreadRef | null;
  toneClassName: string | null;
  repositoryUrl: string | null;
  openOnHostText: string;
  onBack: (() => void) | undefined;
  children?: ReactNode;
}) {
  const gt = useGT();
  const messages = useMessages();
  const openLink = useOpenLink(threadRef);
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
          <SharedTooltipTrigger
            render={
              repositoryUrl ? (
                <InlineButton
                  tone="muted"
                  onClick={(event) => void openLink(repositoryUrl, { event }).catch(console.error)}
                  onAuxClick={(event) => {
                    if (event.button === 1)
                      void openLink(repositoryUrl, { event }).catch(console.error);
                  }}
                >
                  {detail.repository}
                </InlineButton>
              ) : (
                <span className="shrink-0">{detail.repository}</span>
              )
            }
            label={
              repositoryUrl
                ? gt("Open {repository} repository", { repository: detail.repository })
                : detail.repository
            }
          />
          <NumberLink
            detail={detail}
            threadRef={threadRef}
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
