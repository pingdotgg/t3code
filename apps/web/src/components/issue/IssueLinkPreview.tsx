import type { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import type { EnvironmentId, IssueDetail, IssueRef } from "@t3tools/contracts";
import { T, Var } from "gt-react";
import { useRef, useState, type ComponentPropsWithoutRef, type ReactElement } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";

import { PullRequestActorAvatar } from "../pullRequest/pullRequestPresentation";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { issueStatePresentation } from "./issuePresentation";

export interface IssueLinkPreviewTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueRef;
}

export function IssueLinkPreview({
  link,
  originalUrl,
  target,
}: {
  link: ReactElement<ComponentPropsWithoutRef<"a">>;
  originalUrl: string;
  target: IssueLinkPreviewTarget;
}) {
  const [open, setOpen] = useState(false);
  const previewActionsRef = useRef<PreviewCardPrimitive.Root.Actions | null>(null);
  const detailQuery = useEnvironmentQuery(open ? issueEnvironment.detail(target) : null);
  const detail = detailQuery.data;
  const showUrlTooltip = open && detailQuery.error !== null && detail === null;

  return (
    <PreviewCard open={open} onOpenChange={setOpen} actionsRef={previewActionsRef}>
      <Tooltip
        open={showUrlTooltip}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && detail === null) previewActionsRef.current?.close();
        }}
      >
        <PreviewCardTrigger
          render={<TooltipTrigger render={link} />}
          delay={350}
          closeDelay={120}
        />
        <TooltipPopup side="top">{originalUrl}</TooltipPopup>
      </Tooltip>
      {detail === null ? null : (
        <PreviewCardPopup align="center" className="w-80 max-w-[calc(100vw-2rem)]">
          <div className="p-3">
            <IssuePreviewCardBody detail={detail} />
          </div>
        </PreviewCardPopup>
      )}
    </PreviewCard>
  );
}

/** A pull request card's fallback when its reference turns out to be an issue. */
export function IssueLinkPreviewFallback({
  originalUrl,
  target,
}: {
  originalUrl: string;
  target: IssueLinkPreviewTarget;
}) {
  const detail = useEnvironmentQuery(issueEnvironment.detail(target)).data;
  return detail === null ? (
    <p className="break-all text-meta text-muted-foreground">{originalUrl}</p>
  ) : (
    <IssuePreviewCardBody detail={detail} />
  );
}

function IssuePreviewCardBody({ detail }: { detail: IssueDetail }) {
  const state = issueStatePresentation(detail.state);
  const createdAt = <RelativeTime timestamp={detail.createdAt} />;
  const author = detail.author;
  const authorLabel =
    author === null
      ? "ghost"
      : author.name && author.name !== author.login
        ? `${author.name} (@${author.login})`
        : author.login;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
        <span className="min-w-0 truncate">{detail.scope}</span>
        <span className="shrink-0">{detail.displayKey}</span>
        <span className="ms-1 inline-flex shrink-0 items-center gap-1">
          <state.Icon aria-hidden className={`size-3 ${state.toneClassName}`} />
          {state.label}
        </span>
      </div>
      <p className="mt-1 text-label leading-snug text-foreground text-pretty">{detail.title}</p>
      <div className="mt-2 flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
        <PullRequestActorAvatar actor={author} className="size-4" />
        <span className="min-w-0">
          <span className="block truncate">{authorLabel}</span>
          <span className="block">
            <T>
              opened <Var>{createdAt}</Var>
            </T>
          </span>
        </span>
      </div>
    </div>
  );
}
