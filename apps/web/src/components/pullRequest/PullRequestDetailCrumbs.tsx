import type { ScopedThreadRef } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { T, useGT } from "gt-react";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";

import { changeRequestTermKind } from "./changeRequestTerm";

interface CrumbsPullRequest {
  readonly url: string;
  readonly provider: string;
  readonly number: number;
  readonly repository: string;
  readonly title: string;
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

const ROW_CLASS_NAME =
  "col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground transition-[opacity,transform] ease-out motion-reduce:transform-none motion-reduce:transition-none sm:text-xs";

function BackButton({ onBack, focusable }: { onBack: () => void; focusable: boolean }) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            {...(focusable ? {} : { tabIndex: -1 })}
            onClick={onBack}
            className="-ml-1.5"
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
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            {...(focusable ? {} : { tabIndex: -1 })}
            onClick={(event) => void openLink(detail.url, { event }).catch(console.error)}
            onAuxClick={(event) => {
              if (event.button === 1) void openLink(detail.url, { event }).catch(console.error);
            }}
            onContextMenu={(event) => openNumberContextMenu(event, detail)}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 hover:underline",
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
            <ExternalLinkIcon aria-hidden className="size-2.5" />
          </button>
        }
      />
      <TooltipPopup side="top">{openOnHostText}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The repository and number above the title, swapped for the number and title once the reader has
 * scrolled the title away.
 */
export function PullRequestDetailCrumbs({
  detail,
  threadRef,
  toneClassName,
  condensed,
  repositoryUrl,
  openOnHostText,
  onBack,
}: {
  detail: CrumbsPullRequest | null;
  threadRef: ScopedThreadRef | null;
  toneClassName: string | null;
  condensed: boolean;
  repositoryUrl: string | null;
  openOnHostText: string;
  onBack: (() => void) | undefined;
}) {
  const gt = useGT();
  const openLink = useOpenLink(threadRef);
  const ready = detail !== null && toneClassName !== null;
  return (
    <div className="pl-4 grid h-7 min-w-0 items-center overflow-hidden">
      <div
        aria-hidden={condensed}
        inert={condensed}
        data-workspace-scroll-swap
        className={cn(
          ROW_CLASS_NAME,
          condensed
            ? "pointer-events-none -translate-y-1 opacity-0 duration-100"
            : "translate-y-0 opacity-100 delay-50 duration-150",
        )}
      >
        {ready ? (
          <>
            {onBack ? <BackButton onBack={onBack} focusable /> : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  repositoryUrl ? (
                    <button
                      type="button"
                      onClick={(event) =>
                        void openLink(repositoryUrl, { event }).catch(console.error)
                      }
                      onAuxClick={(event) => {
                        if (event.button === 1)
                          void openLink(repositoryUrl, { event }).catch(console.error);
                      }}
                      className="min-w-0 cursor-pointer truncate text-left font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {detail.repository}
                    </button>
                  ) : (
                    <span className="min-w-0 truncate font-medium text-muted-foreground">
                      {detail.repository}
                    </span>
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
              threadRef={threadRef}
              toneClassName={toneClassName}
              openOnHostText={openOnHostText}
              focusable
            />
          </>
        ) : null}
      </div>
      <div
        aria-hidden={!condensed}
        inert={!condensed}
        data-workspace-scroll-swap
        className={cn(
          ROW_CLASS_NAME,
          condensed
            ? "translate-y-0 opacity-100 delay-50 duration-150"
            : "pointer-events-none translate-y-1 opacity-0 duration-100",
        )}
      >
        {ready ? (
          <>
            {onBack ? <BackButton onBack={onBack} focusable={condensed} /> : null}
            <NumberLink
              detail={detail}
              threadRef={threadRef}
              toneClassName={toneClassName}
              openOnHostText={openOnHostText}
              focusable={condensed}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {detail.title}
                  </span>
                }
              />
              <TooltipPopup side="top">{detail.title}</TooltipPopup>
            </Tooltip>
          </>
        ) : null}
      </div>
    </div>
  );
}
