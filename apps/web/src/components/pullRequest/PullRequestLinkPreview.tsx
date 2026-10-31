import type { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import {
  cloneElement,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { pullRequestEnvironment, useSharedPullRequestSummary } from "~/state/pullRequests";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useEnvironmentQuery } from "~/state/query";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestActorAvatar, resolvePullRequestState } from "./pullRequestPresentation";

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
  const summary = useSharedPullRequestSummary(
    open ? target.environmentId : null,
    open ? target.input : null,
  );
  const readPreview = useAtomQueryRunner(pullRequestEnvironment.preview, {
    reportFailure: false,
    reportDefect: false,
  });
  const preview = previewQuery.data;
  const settledPreview = previewQuery.isSuccess && !previewQuery.isPending ? preview : null;
  const openResolved = async (url: string | null) => {
    if (url !== null && onOpenPullRequest?.(url)) return;
    await onOpenFallback?.(originalUrl);
  };
  const logOpenFailure = (error: unknown) => {
    console.error("[pull-request-link-preview] failed to open link", error);
  };
  const trigger =
    confirmBeforeOpen === true
      ? cloneElement(link, {
          onClick: (event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            event.stopPropagation();
            if (resolvingClick) return;
            setOpen(false);
            if (settledPreview !== null) {
              void openResolved(settledPreview.url).catch(logOpenFailure);
              return;
            }
            setResolvingClick(true);
            void readPreview(target)
              .then(async (result) => {
                if (isAtomCommandInterrupted(result)) return;
                await openResolved(result._tag === "Success" ? result.value.url : null);
              })
              .catch(logOpenFailure)
              .finally(() => setResolvingClick(false));
          },
        })
      : link;
  const card = preview ?? summary;
  const showCard = card !== null || (previewQuery.error !== null && fallback !== undefined);
  const showUrlTooltip = open && previewQuery.error !== null && !showCard;
  const state =
    card === null
      ? null
      : resolvePullRequestState({ state: card.state, isDraft: card.isDraft ?? false });
  const authorLabel =
    card?.author === null
      ? "ghost"
      : card?.author?.name && card.author.name !== card.author.login
        ? `${card.author.name} (@${card.author.login})`
        : (card?.author?.login ?? null);

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
                <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                  <span className="min-w-0 truncate">{card.repository}</span>
                  <span className="shrink-0">#{card.number}</span>
                  <span aria-hidden>·</span>
                  {state === null ? null : (
                    <span className="inline-flex shrink-0 items-center gap-1">
                      <state.Icon aria-hidden className={`size-3 ${state.toneClassName}`} />
                      {state.label}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm font-medium leading-snug text-foreground text-pretty">
                  {card.title}
                </p>
                {card.author === undefined ? null : (
                  <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <PullRequestActorAvatar actor={card.author} className="size-4" />
                    <span className="min-w-0 truncate">{authorLabel}</span>
                    {preview === null ? null : (
                      <>
                        <span aria-hidden>·</span>
                        <span className="shrink-0">
                          opened <RelativeTime timestamp={preview.createdAt} />
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </PreviewCardPopup>
      ) : null}
    </PreviewCard>
  );
}
