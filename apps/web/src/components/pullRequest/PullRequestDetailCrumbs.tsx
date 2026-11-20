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

import { changeRequestTermKind } from "./changeRequestTerm";

interface CrumbsPullRequest {
  readonly url: string;
  readonly provider: string;
  readonly number: number;
  readonly repository: string;
  readonly state: "open" | "merged" | "closed";
  readonly isDraft: boolean;
}

/** What a detail's crumbs name: where it lives, and its own key linking to the host. */
export interface WorkItemCrumbsSubject {
  readonly url: string;
  /** The repository or tracker scope, such as `owner/repo` or a Linear team. */
  readonly scope: string;
  readonly scopeUrl: string | null;
  /** `#123`, or a tracker's own key. */
  readonly keyLabel: string;
  readonly keyAriaLabel: string;
  /** The host's name in "Open on GitHub" and the link's context menu. */
  readonly openLabel: string;
}

const openKeyContextMenu = (event: ReactMouseEvent, subject: WorkItemCrumbsSubject): void => {
  event.preventDefault();
  event.stopPropagation();
  void showPullRequestLinkContextMenu({
    url: subject.url,
    openLabel: subject.openLabel,
    position: { x: event.clientX, y: event.clientY },
  });
};

function BackButton({
  onBack,
  label,
  tooltip,
}: {
  onBack: () => void;
  label: string;
  tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            onClick={onBack}
            className="-ms-1.25"
            aria-label={label}
          >
            <ArrowLeftIcon aria-hidden className="size-3.5" />
          </Button>
        }
      />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function KeyLink({
  subject,
  toneClassName,
  openOnHostText,
}: {
  subject: WorkItemCrumbsSubject;
  toneClassName: string;
  openOnHostText: string;
}) {
  return (
    <span className={cn("inline-flex shrink-0", toneClassName)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone={null}
              onClick={() => void readLocalApi()?.shell.openExternal(subject.url)}
              onAuxClick={(event) => {
                if (event.button === 1) void readLocalApi()?.shell.openExternal(subject.url);
              }}
              onContextMenu={(event) => openKeyContextMenu(event, subject)}
              aria-label={subject.keyAriaLabel}
            >
              {subject.keyLabel}
              <ExternalLinkIcon aria-hidden className="size-[13px]" />
            </InlineButton>
          }
        />
        <TooltipPopup side="top">{openOnHostText}</TooltipPopup>
      </Tooltip>
    </span>
  );
}

/**
 * A detail's first line, shared by pull requests and issues: back, the scope, the key in its
 * state's ink, and a badge for any state but open.
 */
export function WorkItemDetailCrumbs({
  subject,
  toneClassName,
  openOnHostText,
  badge,
  back,
  children,
}: {
  subject: WorkItemCrumbsSubject | null;
  toneClassName: string | null;
  openOnHostText: string;
  badge?: ReactNode;
  back?: { readonly onBack: () => void; readonly label: string; readonly tooltip: string };
  children?: ReactNode;
}) {
  const gt = useGT();
  return (
    <div className="mt-2 flex min-h-6 min-w-0 items-center gap-1.5 pl-4 text-label text-muted-foreground">
      {subject && toneClassName ? (
        <>
          {back ? <BackButton {...back} /> : null}
          <Tooltip>
            <TooltipTrigger
              render={
                subject.scopeUrl ? (
                  <InlineButton
                    tone="muted"
                    className="min-w-16 shrink @max-sm/pr-header:hidden"
                    onClick={() =>
                      subject.scopeUrl && void readLocalApi()?.shell.openExternal(subject.scopeUrl)
                    }
                  >
                    <span className="truncate">{subject.scope}</span>
                  </InlineButton>
                ) : (
                  <span className="min-w-16 truncate @max-sm/pr-header:hidden">
                    {subject.scope}
                  </span>
                )
              }
            />
            <TooltipPopup side="top">
              {subject.scopeUrl
                ? gt("Open {repository} repository", { repository: subject.scope })
                : subject.scope}
            </TooltipPopup>
          </Tooltip>
          <KeyLink
            subject={subject}
            toneClassName={toneClassName}
            openOnHostText={openOnHostText}
          />
          {badge}
          {children}
        </>
      ) : null}
    </div>
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
  const term = detail
    ? changeRequestTermKind(sourceControlClients.get(detail.provider).changeRequest)
    : null;
  return (
    <WorkItemDetailCrumbs
      subject={
        detail && term
          ? {
              url: detail.url,
              scope: detail.repository,
              scopeUrl: repositoryUrl,
              keyLabel: `#${detail.number}`,
              keyAriaLabel: gt(
                "Open {term, select, mr {merge request} cr {change request} other {pull request}} #{number} on host",
                { term, number: detail.number },
              ),
              openLabel: openOnHostLabel(sourceControlClients.get(detail.provider)),
            }
          : null
      }
      toneClassName={state ? toneClassName : null}
      openOnHostText={openOnHostText}
      {...(onBack && term
        ? {
            back: {
              onBack,
              label: gt(
                "Back to this thread's {term, select, mr {merge requests} cr {change requests} other {pull requests}}",
                { term },
              ),
              tooltip: gt(
                "Back to {term, select, mr {merge requests} cr {change requests} other {pull requests}}",
                { term },
              ),
            },
          }
        : {})}
      badge={
        detail && state && (detail.state !== "open" || detail.isDraft) ? (
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
            <span className="@max-sm/pr-header:sr-only">{state.label}</span>
          </Badge>
        ) : null
      }
    >
      {children}
    </WorkItemDetailCrumbs>
  );
}
