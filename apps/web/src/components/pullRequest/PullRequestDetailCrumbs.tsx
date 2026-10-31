import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { resolvePullRequestState } from "./pullRequestPresentation";
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

export function PullRequestDetailCrumbs({
  detail,
  toneClassName,
  openOnHostText,
  onBack,
  children,
}: {
  detail: CrumbsPullRequest | null;
  toneClassName: string | null;
  openOnHostText: string;
  onBack: (() => void) | undefined;
  children?: ReactNode;
}) {
  const state = detail ? resolvePullRequestState(detail) : null;
  return (
    <div className="mt-2 flex min-h-6 min-w-0 flex-wrap items-center gap-1.5 pl-4 text-label text-muted-foreground">
      {detail && toneClassName && state ? (
        <>
          {onBack ? (
            <BackButton
              onBack={onBack}
              focusable
              plural={sourceControlClients.get(detail.provider).changeRequest.plural}
            />
          ) : null}
          <NumberLink
            detail={detail}
            toneClassName={toneClassName}
            openOnHostText={openOnHostText}
            focusable
          />
          {detail.state !== "open" || detail.isDraft ? (
            <span
              className={cn(
                "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-[7px] text-caption",
                detail.state === "merged"
                  ? "border-merged-foreground/25 bg-merged-tint text-merged-foreground"
                  : detail.state === "closed"
                    ? "border-error-foreground/25 bg-error-tint text-error-foreground"
                    : "border-border bg-badge-neutral text-muted-foreground",
              )}
            >
              <state.Icon aria-hidden className="size-[11px]" />
              {state.label}
            </span>
          ) : null}
          {children}
        </>
      ) : null}
    </div>
  );
}
