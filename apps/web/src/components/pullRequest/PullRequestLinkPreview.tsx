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
  const showCard = preview !== null || (previewQuery.error !== null && fallback !== undefined);
  const showUrlTooltip = open && previewQuery.error !== null && !showCard;
  const state =
    preview === null
      ? null
      : resolvePullRequestState({ state: preview.state, isDraft: preview.isDraft });
  const authorLabel =
    preview?.author === null
      ? "ghost"
      : preview?.author.name && preview.author.name !== preview.author.login
        ? `${preview.author.name} (@${preview.author.login})`
        : (preview?.author.login ?? null);

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
            {preview === null ? (
              fallback
            ) : (
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                  <span className="min-w-0 truncate">{preview.repository}</span>
                  <span className="shrink-0">#{preview.number}</span>
                  <span aria-hidden>·</span>
                  {state === null ? null : (
                    <span className="inline-flex shrink-0 items-center gap-1">
                      <state.Icon aria-hidden className={`size-3 ${state.toneClassName}`} />
                      {state.label}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm font-medium leading-snug text-foreground text-pretty">
                  {preview.title}
                </p>
                <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <PullRequestActorAvatar actor={preview.author} className="size-4" />
                  <span className="min-w-0 truncate">{authorLabel}</span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0">
                    opened <RelativeTime timestamp={preview.createdAt} />
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
