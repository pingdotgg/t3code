import { ExternalLinkIcon, PaperclipIcon } from "lucide-react";
import { markdownImageSourceFragment } from "@t3tools/client-runtime/markdown-images";
import {
  sourceControlClients,
  type ReferenceAutolink,
} from "@t3tools/client-runtime/source-control-clients";
import {
  SOURCE_CONTROL_MEDIA_ASSET,
  type AssetResource,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { createContext, useContext } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { PULL_REQUESTS_PANEL_REF } from "~/rightPanelStore";

import ChatMarkdown from "../ChatMarkdown";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import {
  remarkPullRequestAutolinks,
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "./pullRequestMarkdown.logic";

export const PullRequestMarkdownContext = createContext<{
  autolinks: ((text: string) => ReadonlyArray<ReferenceAutolink>) | null;
  threadRef: ScopedThreadRef | null;
} | null>(null);

function PullRequestHostVideo({
  environmentId,
  cwd,
  url,
  fetchUrl,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  url: string;
  fetchUrl: string;
}) {
  const resource: AssetResource = { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd, url: fetchUrl };
  const assetUrl = useAssetUrlState(environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(environmentId, resource);
  const src =
    assetUrl._tag === "Success" ? assetUrl.url : assetUrl._tag === "Failure" ? fetchUrl : null;
  return (
    <MediaVideoPlayer
      src={src === null ? null : src + markdownImageSourceFragment(url)}
      originalUrl={url}
      label="Pull request video"
      className="w-full"
      videoClassName="rounded-lg border border-border/60"
      onRetry={refreshAssetUrl}
    />
  );
}

function PullRequestBodySegmentView({
  segment,
  cwd,
  environmentId,
  threadRef,
  extraRemarkPlugins,
}: {
  segment: PullRequestBodySegment;
  cwd: string;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | undefined;
  extraRemarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
}) {
  if (segment.kind === "table") {
    return (
      <div className="space-y-3">
        {segment.rows.map((cells, rowIndex) => (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- rows have no identity besides position
            key={rowIndex}
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}
          >
            {cells.map((cell, cellIndex) => (
              <div
                // oxlint-disable-next-line react/no-array-index-key -- cells have no identity besides position
                key={cellIndex}
                className={cn("min-w-0 space-y-3", cell.header && "font-medium")}
              >
                {cell.segments.map((cellSegment) => (
                  <PullRequestBodySegmentView
                    key={cellSegment.id}
                    segment={cellSegment}
                    cwd={cwd}
                    environmentId={environmentId}
                    threadRef={threadRef}
                    extraRemarkPlugins={extraRemarkPlugins}
                  />
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (segment.kind === "markdown" || segment.media === "image") {
    return (
      <ChatMarkdown
        text={segment.kind === "markdown" ? segment.text : `![](<${segment.url}>)`}
        cwd={cwd}
        threadRef={threadRef}
        pullRequestPanelRef={threadRef ?? PULL_REQUESTS_PANEL_REF}
        environmentId={environmentId}
        extraRemarkPlugins={extraRemarkPlugins}
        sourceControlMedia
      />
    );
  }
  const hostMedia = sourceControlClients.mediaUrl(segment.url);
  if (segment.media === "video" && hostMedia !== null) {
    return (
      <PullRequestHostVideo
        key={`${segment.id}:${segment.url}`}
        environmentId={environmentId}
        cwd={cwd}
        url={segment.url}
        fetchUrl={hostMedia.fetchUrl}
      />
    );
  }
  if (segment.media === "video") {
    return (
      <MediaVideoPlayer
        key={`${segment.id}:${segment.url}`}
        src={segment.url}
        originalUrl={segment.url}
        label="Pull request video"
        className="w-full"
        videoClassName="rounded-lg border border-border/60"
      />
    );
  }
  return (
    // Desktop converts blocked _blank navigation to openExternal.
    <a
      href={segment.url}
      rel="noreferrer noopener"
      target="_blank"
      className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm hover:bg-muted/60"
    >
      <PaperclipIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        Open attachment on {hostMedia?.definition.label ?? new URL(segment.url).hostname}
      </span>
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
    </a>
  );
}

export function PullRequestMarkdown({
  text,
  cwd,
  environmentId,
  threadRef,
  className,
}: {
  text: string;
  cwd: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | null;
  className?: string;
}) {
  const segments = splitPullRequestBody(text);
  const context = useContext(PullRequestMarkdownContext);
  const autolinks = context?.autolinks;
  const resolvedThreadRef = threadRef ?? context?.threadRef ?? undefined;
  const extraRemarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = autolinks
    ? [[remarkPullRequestAutolinks, { autolinks }]]
    : [];
  return (
    <div
      className={cn(
        "space-y-3 [&_[data-markdown-details]]:border-0 [&_[data-markdown-details-summary]]:text-foreground/80 [&_[data-markdown-details-summary]>svg]:text-muted-foreground/60",
        className,
      )}
      data-image-gallery
    >
      {segments.map((segment) => (
        <PullRequestBodySegmentView
          key={segment.id}
          segment={segment}
          cwd={cwd}
          environmentId={environmentId}
          threadRef={resolvedThreadRef}
          extraRemarkPlugins={extraRemarkPlugins}
        />
      ))}
    </div>
  );
}
