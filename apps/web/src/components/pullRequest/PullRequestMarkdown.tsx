import { ExternalLinkIcon, PaperclipIcon } from "lucide-react";
import {
  isGitHubAttachmentUrl,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { createContext, useContext, useMemo } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { PULL_REQUESTS_PANEL_REF } from "~/rightPanelStore";

import ChatMarkdown from "../ChatMarkdown";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { remarkPullRequestAutolinks, splitPullRequestBody } from "./pullRequestMarkdown.logic";

const VIDEO_CLASS_NAME = "rounded-lg border border-border/60";

/** A private repository's upload 404s without GitHub credentials, so the environment resolves it. */
function PullRequestAttachmentVideo({
  environmentId,
  url,
}: {
  environmentId: EnvironmentId;
  url: string;
}) {
  const resource = useMemo(() => ({ _tag: "github-attachment", url }) as const, [url]);
  const assetUrl = useAssetUrlState(environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(environmentId, resource);
  // An older environment cannot mint the URL; the authored link is what played before,
  // and a retry then reloads that link instead of asking the environment again.
  const showsAuthoredUrl = assetUrl._tag === "Failure";
  const src = assetUrl._tag === "Success" ? assetUrl.url : showsAuthoredUrl ? url : null;
  return (
    <MediaVideoPlayer
      src={src}
      originalUrl={url}
      label="Pull request video"
      className="w-full"
      videoClassName={VIDEO_CLASS_NAME}
      onRetry={showsAuthoredUrl ? undefined : refreshAssetUrl}
    />
  );
}

export const PullRequestMarkdownContext = createContext<{
  repositoryUrl: string | null;
  threadRef: ScopedThreadRef | null;
} | null>(null);

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
  const segments = splitPullRequestBody(text);
  const context = useContext(PullRequestMarkdownContext);
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
            />
          );
        }
        if (segment.media === "video") {
          return isGitHubAttachmentUrl(segment.url) ? (
            <PullRequestAttachmentVideo
              key={`${segment.id}:${segment.url}`}
              environmentId={environmentId}
              url={segment.url}
            />
          ) : (
            <MediaVideoPlayer
              key={`${segment.id}:${segment.url}`}
              src={segment.url}
              originalUrl={segment.url}
              label="Pull request video"
              className="w-full"
              videoClassName={VIDEO_CLASS_NAME}
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
