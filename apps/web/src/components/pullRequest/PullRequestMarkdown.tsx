import { ExternalLinkIcon, PaperclipIcon } from "lucide-react";
import { markdownImageSourceFragment } from "@t3tools/client-runtime/markdown-images";
import { gitlabUploadSource, type GitLabUploadContext } from "@t3tools/shared/gitlabUploads";
import { githubMediaFetchUrl } from "@t3tools/shared/githubMedia";
import type { AssetResource, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext, useMemo } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { PULL_REQUESTS_PANEL_REF } from "~/rightPanelStore";

import ChatMarkdown from "../ChatMarkdown";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { remarkPullRequestAutolinks, splitPullRequestBody } from "./pullRequestMarkdown.logic";

export const PullRequestMarkdownContext = createContext<{
  repositoryUrl: string | null;
  gitlabUploads?: GitLabUploadContext | undefined;
  threadRef: ScopedThreadRef | null;
} | null>(null);

/**
 * A repository upload plays through a signed asset URL the server
 * fetches with its hosting credential, which is what a private repository's
 * uploads need; the URL is re-signed on retry, so a stale one recovers without a reload.
 */
function PullRequestAssetVideo({
  environmentId,
  resource,
  url,
  fetchUrl,
}: {
  environmentId: EnvironmentId;
  resource: AssetResource;
  /** What the body authored, which is what "Open original" should reach. */
  url: string;
  /** Direct media URL without a fragment, also used when signing is unavailable. */
  fetchUrl: string;
}) {
  const assetUrl = useAssetUrlState(environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(environmentId, resource);
  // A server too old to sign this resource, or one with no route to the host, still leaves a
  // public repository's video playing exactly as it did before.
  const src =
    assetUrl._tag === "Success" ? assetUrl.url : assetUrl._tag === "Failure" ? fetchUrl : null;
  return (
    <MediaVideoPlayer
      src={src === null ? null : src + markdownImageSourceFragment(url)}
      fallbackSrc={
        resource._tag === "gitlab-upload" ? fetchUrl + markdownImageSourceFragment(url) : undefined
      }
      originalUrl={url}
      label="Pull request video"
      className="w-full"
      videoClassName="rounded-lg border border-border/60"
      onRetry={refreshAssetUrl}
    />
  );
}

/** Renders PR uploads inline, with retry and an original link when video playback fails. */
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
  /** Thread the body is shown beside, so its links can open in that thread's in-app browser. */
  threadRef?: ScopedThreadRef | null;
  className?: string;
}) {
  const context = useContext(PullRequestMarkdownContext);
  const segments = splitPullRequestBody(text, context?.gitlabUploads);
  const repositoryUrl = context?.repositoryUrl;
  const resolvedThreadRef = threadRef ?? context?.threadRef ?? undefined;
  const extraRemarkPlugins = useMemo<NonNullable<ReactMarkdownOptions["remarkPlugins"]>>(
    () => (repositoryUrl ? [[remarkPullRequestAutolinks, { repositoryUrl }]] : []),
    [repositoryUrl],
  );
  return (
    <div
      className={cn(
        "space-y-3 [&_[data-markdown-details]]:border-0 [&_[data-markdown-details-summary]]:text-foreground/80 [&_[data-markdown-details-summary]>svg]:text-muted-foreground/60",
        className,
      )}
      data-image-gallery
    >
      {segments.map((segment) => {
        if (segment.kind === "markdown") {
          return (
            <ChatMarkdown
              key={segment.id}
              text={segment.text}
              cwd={cwd}
              threadRef={resolvedThreadRef}
              pullRequestPanelRef={resolvedThreadRef ?? PULL_REQUESTS_PANEL_REF}
              environmentId={environmentId}
              extraRemarkPlugins={extraRemarkPlugins}
              githubMedia
              gitlabUploads={context?.gitlabUploads}
            />
          );
        }
        const githubMediaUrl = segment.media === "video" ? githubMediaFetchUrl(segment.url) : null;
        const gitlabUpload =
          segment.media === "video" && context?.gitlabUploads
            ? gitlabUploadSource(segment.url, context.gitlabUploads)
            : null;
        if (githubMediaUrl !== null || gitlabUpload !== null) {
          return (
            <PullRequestAssetVideo
              key={`${segment.id}:${segment.url}`}
              environmentId={environmentId}
              resource={
                gitlabUpload !== null
                  ? { _tag: "gitlab-upload", reference: gitlabUpload.reference }
                  : { _tag: "github-media", cwd, url: githubMediaUrl! }
              }
              url={segment.url}
              fetchUrl={gitlabUpload?.url.split("#", 1)[0] ?? githubMediaUrl!}
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
          // A plain anchor rather than the page's openExternal button: the desktop window
          // turns a blocked _blank into openExternal itself, and in a browser tab — where
          // there is no shell to call — this is the only one of the two that goes anywhere.
          <a
            key={segment.id}
            href={segment.url}
            rel="noreferrer noopener"
            target="_blank"
            className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm hover:bg-muted/60"
          >
            <PaperclipIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Open attachment on GitHub</span>
            <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </a>
        );
      })}
    </div>
  );
}
