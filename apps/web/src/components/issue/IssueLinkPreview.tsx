import type { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import type { EnvironmentId, IssueDetail, IssueRef } from "@t3tools/contracts";
import { T, Var } from "gt-react";
import { useRef, useState, type ComponentPropsWithoutRef, type ReactElement } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";

import {
  WorkItemPreviewCardAuthor,
  WorkItemPreviewCardHeader,
  WorkItemPreviewCardTitle,
} from "../pullRequest/PullRequestLinkPreview";
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
  return (
    <div className="min-w-0">
      <WorkItemPreviewCardHeader
        scope={detail.scope}
        keyLabel={detail.displayKey}
        state={state}
        stateLabel
      />
      <WorkItemPreviewCardTitle>{detail.title}</WorkItemPreviewCardTitle>
      <WorkItemPreviewCardAuthor
        actor={detail.author}
        opened={
          <span className="block">
            <T>
              opened <Var>{createdAt}</Var>
            </T>
          </span>
        }
      />
    </div>
  );
}
