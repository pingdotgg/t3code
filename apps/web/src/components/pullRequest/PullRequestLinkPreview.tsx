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

import { shouldOpenPullRequestExternally, useBrowserLinkTarget } from "~/lib/openPullRequestLink";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useEnvironmentQuery } from "~/state/query";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestActorAvatar, resolvePullRequestState } from "./pullRequestPresentation";

interface PullRequestLinkPreviewTarget {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestRef;
}

interface LinkClickModifiers {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
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
  /** Receives the click's modifiers, which pick between the panel and the browser. */
  onOpenPullRequest?: (url: string, modifiers: LinkClickModifiers) => boolean;
  onOpenFallback?: (url: string, modifiers: LinkClickModifiers) => Promise<void>;
  fallback?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const previewActionsRef = useRef<PreviewCardPrimitive.Root.Actions | null>(null);
  const [resolvingClick, setResolvingClick] = useState(false);
  const linkTargetPreference = useBrowserLinkTarget();
  const detailQuery = useEnvironmentQuery(
    open
      ? pullRequestEnvironment.detail({
          environmentId: target.environmentId,
          input: target.input,
        })
      : null,
  );
  const readPreview = useAtomQueryRunner(pullRequestEnvironment.preview, {
    reportFailure: false,
    reportDefect: false,
  });
  const trigger =
    confirmBeforeOpen === true
      ? cloneElement(link, {
          onClick: (event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>) => {
            // A click headed for the browser keeps the link's own navigation: waiting on the
            // lookup first would outlive the click's permission to open a tab.
            if (
              event.shiftKey ||
              event.altKey ||
              shouldOpenPullRequestExternally(event, linkTargetPreference)
            )
              return;
            const modifiers = { metaKey: event.metaKey, ctrlKey: event.ctrlKey };
            event.preventDefault();
            event.stopPropagation();
            if (resolvingClick) return;
            setOpen(false);
            setResolvingClick(true);
            void readPreview(target)
              .then(async (result) => {
                if (isAtomCommandInterrupted(result)) return;
                if (result._tag === "Success" && onOpenPullRequest?.(result.value.url, modifiers))
                  return;
                await onOpenFallback?.(originalUrl, modifiers);
              })
              .catch((error: unknown) => {
                console.error("[pull-request-link-preview] failed to open link", error);
              })
              .finally(() => setResolvingClick(false));
          },
        })
      : link;
  const detail = detailQuery.data;
  const showCard = detail !== null || (detailQuery.error !== null && fallback !== undefined);
  const showUrlTooltip = open && detailQuery.error !== null && !showCard;
  const state =
    detail === null
      ? null
      : resolvePullRequestState({ state: detail.state, isDraft: detail.isDraft });
  const authorLabel =
    detail?.author === null
      ? "ghost"
      : detail?.author.name && detail.author.name !== detail.author.login
        ? `${detail.author.name} (@${detail.author.login})`
        : (detail?.author.login ?? null);

  return (
    <PreviewCard open={open} onOpenChange={setOpen} actionsRef={previewActionsRef}>
      <Tooltip
        open={showUrlTooltip}
        onOpenChange={(nextOpen) => {
          // Cancel the card's delayed hover too, without changing its content preview.
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
            {detail === null ? (
              fallback
            ) : (
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                  <span className="min-w-0 truncate">{detail.repository}</span>
                  <span className="shrink-0">#{detail.number}</span>
                  <span aria-hidden>·</span>
                  {state === null ? null : (
                    <span className="inline-flex shrink-0 items-center gap-1">
                      <state.Icon aria-hidden className={`size-3 ${state.toneClassName}`} />
                      {state.label}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm font-medium leading-snug text-foreground text-pretty">
                  {detail.title}
                </p>
                <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <PullRequestActorAvatar actor={detail.author} className="size-4" />
                  <span className="min-w-0 truncate">{authorLabel}</span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0">
                    opened {formatRelativeTimeLabel(detail.createdAt)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </PreviewCardPopup>
      ) : null}
    </PreviewCard>
  );
}
