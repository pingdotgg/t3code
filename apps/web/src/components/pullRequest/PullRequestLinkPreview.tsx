import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { cloneElement, useState, type ComponentPropsWithoutRef, type ReactElement } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useEnvironmentQuery } from "~/state/query";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { PullRequestActorAvatar, resolvePullRequestState } from "./pullRequestPresentation";

interface PullRequestLinkPreviewTarget {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestRef;
}

type PullRequestLinkElement = ReactElement<ComponentPropsWithoutRef<"a">>;

export function PullRequestLinkPreview({
  link,
  originalUrl,
  target,
  confirmBeforeOpen,
  onOpenPullRequest,
  onOpenFallback,
}: {
  link: PullRequestLinkElement;
  originalUrl: string;
  target: PullRequestLinkPreviewTarget;
  confirmBeforeOpen: boolean;
  onOpenPullRequest: (url: string) => boolean;
  onOpenFallback: (url: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [resolvingClick, setResolvingClick] = useState(false);
  const detailQuery = useEnvironmentQuery(
    open
      ? pullRequestEnvironment.detail({
          environmentId: target.environmentId,
          input: target.input,
        })
      : null,
  );
  const readDetail = useAtomQueryRunner(pullRequestEnvironment.detail, {
    reportFailure: false,
    reportDefect: false,
  });

  const trigger = confirmBeforeOpen
    ? cloneElement(link, {
        onClick: (event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          event.stopPropagation();
          if (resolvingClick) return;
          setOpen(false);
          setResolvingClick(true);
          void readDetail({ environmentId: target.environmentId, input: target.input })
            .then(async (result) => {
              if (isAtomCommandInterrupted(result)) return;
              if (result._tag === "Success" && onOpenPullRequest(result.value.url)) return;
              await onOpenFallback(originalUrl);
            })
            .catch((error: unknown) => {
              console.error("[pull-request-link-preview] failed to open link", error);
            })
            .finally(() => setResolvingClick(false));
        },
      })
    : link;
  const detail = detailQuery.data;
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
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger render={trigger} delay={350} closeDelay={120} />
      <PreviewCardPopup align="center" className="w-80 max-w-[calc(100vw-2rem)] p-3">
        {detail === null ? (
          <p className="text-xs leading-relaxed text-muted-foreground wrap-anywhere">
            {detailQuery.isPending ? "Loading pull request details…" : originalUrl}
          </p>
        ) : (
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
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
              <span className="shrink-0">opened {formatRelativeTimeLabel(detail.createdAt)}</span>
            </div>
          </div>
        )}
      </PreviewCardPopup>
    </PreviewCard>
  );
}
