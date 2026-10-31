import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";

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
  "col-start-1 row-start-1 flex min-w-0 items-center text-muted-foreground transition-[opacity,transform] ease-out motion-reduce:transform-none motion-reduce:transition-none";

function BackButton({
  onBack,
  focusable,
  plural,
}: {
  onBack: () => void;
  focusable: boolean;
  plural: string;
}) {
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
            aria-label={`Back to this thread's ${plural}`}
          >
            <ArrowLeftIcon aria-hidden className="size-3.5" />
          </Button>
        }
      />
      <TooltipPopup side="top">Back to {plural}</TooltipPopup>
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
              aria-label={`Open ${sourceControlClients.get(detail.provider).changeRequest.singular} #${detail.number} on host`}
            >
              #{detail.number}
              <ExternalLinkIcon aria-hidden className="size-2.5" />
            </InlineButton>
          }
        />
        <TooltipPopup side="top">{openOnHostText}</TooltipPopup>
      </Tooltip>
    </span>
  );
}

/**
 * The number and title by default, swapped for repository crumbs while the title is being edited.
 */
export function PullRequestDetailCrumbs({
  detail,
  toneClassName,
  condensed,
  repositoryUrl,
  openOnHostText,
  onBack,
}: {
  detail: CrumbsPullRequest | null;
  toneClassName: string | null;
  condensed: boolean;
  repositoryUrl: string | null;
  openOnHostText: string;
  onBack: (() => void) | undefined;
}) {
  const ready = detail !== null && toneClassName !== null;
  return (
    <div className="mt-3 grid h-8 min-w-0 items-center overflow-hidden pl-4">
      <div
        aria-hidden={condensed}
        inert={condensed}
        className={cn(
          ROW_CLASS_NAME,
          "gap-1 text-body sm:text-meta",
          condensed
            ? "pointer-events-none -translate-y-1 opacity-0 duration-100"
            : "translate-y-0 opacity-100 delay-50 duration-150",
        )}
      >
        {ready ? (
          <>
            {onBack ? (
              <BackButton
                onBack={onBack}
                focusable
                plural={sourceControlClients.get(detail.provider).changeRequest.plural}
              />
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  repositoryUrl ? (
                    <InlineButton
                      tone="muted"
                      onClick={() => void readLocalApi()?.shell.openExternal(repositoryUrl)}
                      className="min-w-0 shrink"
                    >
                      <span className="min-w-0 truncate">{detail.repository}</span>
                    </InlineButton>
                  ) : (
                    <span className="min-w-0 truncate text-label text-muted-foreground sm:text-meta">
                      {detail.repository}
                    </span>
                  )
                }
              />
              <TooltipPopup side="top">
                {repositoryUrl ? `Open ${detail.repository} repository` : detail.repository}
              </TooltipPopup>
            </Tooltip>
            <NumberLink
              detail={detail}
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
        className={cn(
          ROW_CLASS_NAME,
          "gap-1.5 text-meta",
          condensed
            ? "translate-y-0 opacity-100 delay-50 duration-150"
            : "pointer-events-none translate-y-1 opacity-0 duration-100",
        )}
      >
        {ready ? (
          <>
            {onBack ? (
              <BackButton
                onBack={onBack}
                focusable={condensed}
                plural={sourceControlClients.get(detail.provider).changeRequest.plural}
              />
            ) : null}
            <NumberLink
              detail={detail}
              toneClassName={toneClassName}
              openOnHostText={openOnHostText}
              focusable={condensed}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="min-w-0 truncate text-label text-foreground">
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
