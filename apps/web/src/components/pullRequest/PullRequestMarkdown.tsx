import { T, useGT, Var } from "gt-react";
import { ExternalLinkIcon, PaperclipIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { markdownImageSourceFragment } from "@t3tools/client-runtime/markdown-images";
import { makePullRequestMediaKindAtom } from "@t3tools/client-runtime/pull-request-markdown";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  SOURCE_CONTROL_MEDIA_ASSET,
  type AssetResource,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { MarkdownExtensions } from "~/markdown/wordsHast";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { PULL_REQUESTS_PANEL_REF } from "~/rightPanelStore";

import ChatMarkdown from "../ChatMarkdown";
import { markdownImageCopy } from "../chat/ChatMarkdownMedia";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { splitPullRequestBody, type PullRequestBodySegment } from "./pullRequestMarkdown.logic";

export const PullRequestMarkdownContext = createContext<{
  /** Stable per repository, so comments share one renderer and its parse cache. */
  extensions: MarkdownExtensions;
  lineBreaks: boolean;
  threadRef: ScopedThreadRef | null;
  /** The change request's `owner/name`, which can differ from the checkout the body renders in. */
  repository: string | null;
} | null>(null);

/** The list page panel that links in thread-less markdown open in; the Issues page provides its own. */
export const PullRequestMarkdownPanelContext =
  createContext<ScopedThreadRef>(PULL_REQUESTS_PANEL_REF);

const pullRequestMediaKind = makePullRequestMediaKindAtom((url, options) => fetch(url, options));

function PullRequestHostMedia({
  environmentId,
  cwd,
  url,
  fetchUrl,
  repository,
  label,
  image,
  fallback,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  url: string;
  fetchUrl: string;
  repository: string | undefined;
  label: string | undefined;
  image?: ReactNode;
  fallback?: ReactNode;
}) {
  const gt = useGT();
  const resource: AssetResource = {
    _tag: SOURCE_CONTROL_MEDIA_ASSET,
    cwd,
    url: fetchUrl,
    ...(repository ? { repository } : {}),
  };
  const assetUrl = useAssetUrlState(environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(environmentId, resource);
  const src =
    assetUrl._tag === "Success" ? assetUrl.url : assetUrl._tag === "Failure" ? fetchUrl : null;
  const [kind, setKind] = useState<"image" | "video" | null>(null);
  const detected = useAtomValue(
    pullRequestMediaKind(
      image === undefined || kind !== null || assetUrl._tag !== "Success" ? null : src,
    ),
  );
  const detectedKind = detected._tag === "Success" ? detected.value : null;
  if (kind === null && detectedKind !== null) setKind(detectedKind);
  if (image !== undefined) {
    if (kind === null) return fallback;
    if (kind === "image") return image;
  }
  return (
    <MediaVideoPlayer
      src={src === null ? null : src + markdownImageSourceFragment(url)}
      originalUrl={url}
      label={label ?? gt("Pull request video")}
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
  lineBreaks,
  onTaskListChange,
}: {
  segment: PullRequestBodySegment;
  cwd: string;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | undefined;
  lineBreaks: boolean;
  onTaskListChange: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
}) {
  const gt = useGT();
  const context = useContext(PullRequestMarkdownContext);
  const listPanelRef = useContext(PullRequestMarkdownPanelContext);
  const repository = context?.repository ?? undefined;
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
                    lineBreaks={lineBreaks}
                    onTaskListChange={onTaskListChange}
                  />
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  const hostMedia =
    segment.kind === "attachment" ? sourceControlClients.mediaUrl(segment.url) : null;
  if (segment.kind === "markdown" || segment.media !== "video") {
    const markdown = (
      <ChatMarkdown
        text={
          segment.kind === "markdown"
            ? segment.text
            : markdownImageCopy(segment.label ?? "", segment.url, undefined)
        }
        cwd={cwd}
        threadRef={threadRef}
        pullRequestPanelRef={threadRef ?? listPanelRef}
        environmentId={environmentId}
        {...(context ? { extensions: context.extensions } : {})}
        lineBreaks={lineBreaks}
        sourceControlMedia
        sourceControlMediaRepository={repository}
        workspaceFileLinksOnly
        onTaskListChange={
          onTaskListChange && segment.kind === "markdown"
            ? ({ markerOffset, checked }) =>
                onTaskListChange({
                  markerOffset: segment.sourceOffset + markerOffset,
                  checked,
                })
            : undefined
        }
      />
    );
    if (segment.kind === "markdown" || segment.media === "image") return markdown;
    const fallback = (
      <PullRequestAttachmentLink
        attachmentUrl={segment.url}
        sourceControlHostLabel={hostMedia?.definition.label}
        label={segment.label}
      />
    );
    return hostMedia === null ? (
      fallback
    ) : (
      <PullRequestHostMedia
        key={segment.url}
        environmentId={environmentId}
        cwd={cwd}
        url={segment.url}
        fetchUrl={hostMedia.fetchUrl}
        repository={repository}
        label={segment.label}
        image={markdown}
        fallback={fallback}
      />
    );
  }
  if (hostMedia !== null) {
    return (
      <PullRequestHostMedia
        key={`${segment.id}:${segment.url}`}
        environmentId={environmentId}
        cwd={cwd}
        url={segment.url}
        fetchUrl={hostMedia.fetchUrl}
        repository={repository}
        label={segment.label}
      />
    );
  }
  return (
    <MediaVideoPlayer
      key={`${segment.id}:${segment.url}`}
      src={segment.url}
      originalUrl={segment.url}
      label={segment.label ?? gt("Pull request video")}
      className="w-full"
      videoClassName="rounded-lg border border-border/60"
    />
  );
}

function PullRequestAttachmentLink({
  attachmentUrl,
  sourceControlHostLabel,
  label,
}: {
  attachmentUrl: string;
  sourceControlHostLabel: string | undefined;
  label: string | undefined;
}) {
  return (
    // Desktop converts blocked _blank navigation to openExternal.
    <a
      href={attachmentUrl}
      rel="noreferrer noopener"
      target="_blank"
      className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm hover:bg-muted/60"
    >
      <PaperclipIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        {label ?? (
          <T>
            Open attachment on{" "}
            <Var>{sourceControlHostLabel ?? new URL(attachmentUrl).hostname}</Var>
          </T>
        )}
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
  lineBreaks,
  className,
  onTaskListChange,
}: {
  text: string;
  cwd: string;
  environmentId: EnvironmentId;
  threadRef?: ScopedThreadRef | null;
  lineBreaks?: boolean;
  className?: string;
  /** `markerOffset` is into `text`. Checkboxes stay read-only without it. */
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
}) {
  const segments = splitPullRequestBody(text);
  const context = useContext(PullRequestMarkdownContext);
  const resolvedThreadRef = threadRef ?? context?.threadRef ?? undefined;
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
          lineBreaks={lineBreaks ?? context?.lineBreaks ?? false}
          onTaskListChange={onTaskListChange}
        />
      ))}
    </div>
  );
}
