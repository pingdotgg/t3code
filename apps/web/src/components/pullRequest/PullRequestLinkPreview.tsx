import type { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useMessages } from "gt-react";
import { parsePullRequestAnchor, pullRequestLinkCommit } from "@t3tools/shared/pullRequestAnchor";
import type { EnvironmentId, PullRequestActor, PullRequestRef } from "@t3tools/contracts";
import {
  cloneElement,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { pullRequestEnvironment, useSharedPullRequestSummary } from "~/state/pullRequests";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useEnvironmentQuery } from "~/state/query";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { pullRequestLinkSubject, pullRequestReviewOutcome } from "./pullRequestDetail.logic";
import {
  PullRequestActorAvatar,
  PullRequestReviewOutcomeBadge,
  resolvePullRequestState,
} from "./pullRequestPresentation";

interface PullRequestLinkPreviewTarget {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestRef;
}

type PullRequestLinkElement = ReactElement<
  ComponentPropsWithoutRef<"a"> | ComponentPropsWithoutRef<"button">
>;

export function PullRequestLinkPreview({
  link,
  originalUrl,
  target,
  confirmBeforeOpen,
  onOpenPullRequest,
  onOpenFallback,
  fallback,
}: {
  link: PullRequestLinkElement;
  originalUrl: string;
  target: PullRequestLinkPreviewTarget;
  confirmBeforeOpen?: boolean;
  onOpenPullRequest?: (url: string) => boolean;
  onOpenFallback?: (url: string) => Promise<void>;
  fallback?: ReactNode;
}) {
  const messages = useMessages();
  const [open, setOpen] = useState(false);
  const previewActionsRef = useRef<PreviewCardPrimitive.Root.Actions | null>(null);
  const [resolvingClick, setResolvingClick] = useState(false);
  const previewQuery = useEnvironmentQuery(
    open
      ? pullRequestEnvironment.previewCard({
          environmentId: target.environmentId,
          input: target.input,
        })
      : null,
  );
  // A link to a comment or commit shows that, read from the activity the panel shares.
  const anchor = parsePullRequestAnchor(originalUrl);
  const linksCommit = pullRequestLinkCommit(originalUrl) !== null;
  const namesSubject = anchor?.kind === "timeline" || linksCommit;
  const activityQuery = useEnvironmentQuery(
    open && namesSubject
      ? pullRequestEnvironment.activity({
          environmentId: target.environmentId,
          input: target.input,
        })
      : null,
  );
  const subject =
    activityQuery.data === null ? null : pullRequestLinkSubject(originalUrl, activityQuery.data);
  const pendingSubject =
    activityQuery.data !== null || activityQuery.error !== null
      ? null
      : linksCommit
        ? "commit"
        : anchor?.kind === "timeline" && !/^event-/i.test(anchor.anchor)
          ? "comment"
          : null;
  const summary = useSharedPullRequestSummary(
    open ? target.environmentId : null,
    open ? target.input : null,
  );
  const readPreview = useAtomQueryRunner(pullRequestEnvironment.preview, {
    reportFailure: false,
    reportDefect: false,
  });
  const trigger =
    confirmBeforeOpen === true
      ? cloneElement(link, {
          onClick: (event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            event.stopPropagation();
            if (resolvingClick) return;
            setOpen(false);
            setResolvingClick(true);
            void readPreview(target)
              .then(async (result) => {
                if (isAtomCommandInterrupted(result)) return;
                if (result._tag === "Success" && onOpenPullRequest?.(result.value.url)) return;
                await onOpenFallback?.(originalUrl);
              })
              .catch((error: unknown) => {
                console.error("[pull-request-link-preview] failed to open link", error);
              })
              .finally(() => setResolvingClick(false));
          },
        })
      : link;
  const preview = previewQuery.data;
  const card = preview ?? summary;
  const showCard = card !== null || (previewQuery.error !== null && fallback !== undefined);
  const showUrlTooltip = open && previewQuery.error !== null && !showCard;
  const state =
    card === null
      ? null
      : resolvePullRequestState({ state: card.state, isDraft: card.isDraft ?? false }, messages);

  return (
    <PreviewCard open={open} onOpenChange={setOpen} actionsRef={previewActionsRef}>
      <Tooltip
        open={showUrlTooltip}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !showCard) previewActionsRef.current?.close();
        }}
      >
        <PreviewCardTrigger
          render={<TooltipTrigger render={trigger} />}
          delay={350}
          closeDelay={120}
        />
        <TooltipPopup side="top">{originalUrl}</TooltipPopup>
      </Tooltip>
      {showCard ? (
        <PreviewCardPopup align="center" className="w-80 max-w-[calc(100vw-2rem)]">
          <div className="p-3">
            {card === null ? (
              fallback
            ) : (
              <div className="min-w-0">
                <WorkItemPreviewCardHeader
                  scope={card.repository}
                  keyLabel={`#${card.number}`}
                  state={state}
                />
                {pendingSubject === "comment" ? (
                  <LinkedCommentSkeleton />
                ) : pendingSubject === "commit" ? (
                  <LinkedCommitSkeleton />
                ) : subject?.kind === "comment" ? (
                  <LinkedComment subject={subject} />
                ) : subject?.kind === "commit" ? (
                  <LinkedCommit commit={subject.commit} />
                ) : (
                  <WorkItemPreviewCardTitle>{card.title}</WorkItemPreviewCardTitle>
                )}
                {card.author === undefined || subject !== null || pendingSubject !== null ? null : (
                  <WorkItemPreviewCardAuthor
                    actor={card.author}
                    opened={
                      preview !== null ? (
                        <span className="block">
                          opened <RelativeTime timestamp={preview.createdAt} />
                        </span>
                      ) : previewQuery.error === null ? (
                        <SkeletonLine>
                          <Skeleton className="h-3 w-20" />
                        </SkeletonLine>
                      ) : null
                    }
                  />
                )}
              </div>
            )}
          </div>
        </PreviewCardPopup>
      ) : null}
    </PreviewCard>
  );
}

/** A hover card's first line, shared by pull requests and issues: scope, key and state. */
export function WorkItemPreviewCardHeader({
  scope,
  keyLabel,
  state,
  stateLabel = false,
}: {
  scope: string;
  keyLabel: string;
  /** Says the state in words, for a tracker whose workflow names its own states. */
  stateLabel?: boolean;
  state: {
    readonly Icon: ElementType<{
      className?: string;
      "aria-label"?: string;
      "aria-hidden"?: boolean;
    }>;
    readonly label: string;
    readonly toneClassName: string;
  } | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
      <span className="min-w-0 truncate">{scope}</span>
      <span className="shrink-0">{keyLabel}</span>
      {state === null ? null : stateLabel ? (
        <span className="ms-1 inline-flex shrink-0 items-center gap-1">
          <state.Icon aria-hidden className={`size-3 ${state.toneClassName}`} />
          {state.label}
        </span>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
            <state.Icon aria-label={state.label} className={`size-3 ${state.toneClassName}`} />
          </TooltipTrigger>
          <TooltipPopup>{state.label}</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

export function WorkItemPreviewCardTitle({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-label leading-snug text-foreground text-pretty">{children}</p>;
}

/** Who opened it, and when once that is known. */
export function WorkItemPreviewCardAuthor({
  actor,
  opened,
}: {
  actor: PullRequestActor | null;
  opened: ReactNode;
}) {
  const label =
    actor === null
      ? "ghost"
      : actor.name && actor.name !== actor.login
        ? `${actor.name} (@${actor.login})`
        : actor.login;
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
      <PullRequestActorAvatar actor={actor} className="size-4" />
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {opened}
      </span>
    </div>
  );
}

function SkeletonLine({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`flex h-lh items-center ${className}`}>{children}</span>;
}

function LinkedCommentSkeleton() {
  return (
    <div className="mt-2 min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-meta">
        <Skeleton shape="pill" className="size-4 shrink-0" />
        <SkeletonLine className="text-label">
          <Skeleton className="h-3 w-24" />
        </SkeletonLine>
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="mt-1.5 text-meta leading-relaxed">
        <SkeletonLine>
          <Skeleton className="h-3 w-full" />
        </SkeletonLine>
        <SkeletonLine>
          <Skeleton className="h-3 w-full" />
        </SkeletonLine>
        <SkeletonLine>
          <Skeleton className="h-3 w-full" />
        </SkeletonLine>
        <SkeletonLine>
          <Skeleton className="h-3 w-2/3" />
        </SkeletonLine>
      </div>
    </div>
  );
}

function LinkedCommitSkeleton() {
  return (
    <div className="mt-2 min-w-0">
      <div className="text-label leading-snug">
        <SkeletonLine>
          <Skeleton className="h-3.5 w-full" />
        </SkeletonLine>
        <SkeletonLine>
          <Skeleton className="h-3.5 w-2/3" />
        </SkeletonLine>
      </div>
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-meta">
        <SkeletonLine>
          <Skeleton className="h-3 w-12" />
        </SkeletonLine>
        <Skeleton shape="pill" className="size-4 shrink-0" />
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-12" />
      </div>
    </div>
  );
}

function actorLabel(actor: { readonly login: string } | null | undefined) {
  return actor?.login ?? "ghost";
}

function LinkedComment({
  subject,
}: {
  subject: Extract<ReturnType<typeof pullRequestLinkSubject>, { kind: "comment" }>;
}) {
  const outcome = pullRequestReviewOutcome(subject.reviewState);
  return (
    <div className="mt-2 min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
        <PullRequestActorAvatar actor={subject.author} className="size-4" />
        <span className="min-w-0 truncate text-label text-foreground">
          {actorLabel(subject.author)}
        </span>
        {outcome === null ? (
          <span className="shrink-0">commented</span>
        ) : (
          <PullRequestReviewOutcomeBadge outcome={outcome} className="shrink-0" />
        )}
        <span className="shrink-0">
          <RelativeTime timestamp={subject.createdAt} />
        </span>
      </div>
      {subject.excerpt === null ? null : (
        <p className="mt-1.5 line-clamp-4 text-meta leading-relaxed text-foreground text-pretty">
          {subject.excerpt}
        </p>
      )}
    </div>
  );
}

function LinkedCommit({
  commit,
}: {
  commit: Extract<ReturnType<typeof pullRequestLinkSubject>, { kind: "commit" }>["commit"];
}) {
  const author = commit.authors?.[0];
  return (
    <div className="mt-2 min-w-0">
      <p className="text-label leading-snug text-foreground text-pretty">
        {commit.messageHeadline}
      </p>
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
        <code className="shrink-0 font-mono">{commit.oid.slice(0, 7)}</code>
        {author === undefined ? null : (
          <>
            <PullRequestActorAvatar actor={author} className="size-4" />
            <span className="min-w-0 truncate">{actorLabel(author)}</span>
          </>
        )}
        <span className="shrink-0">
          <RelativeTime timestamp={commit.committedDate} />
        </span>
      </div>
    </div>
  );
}
