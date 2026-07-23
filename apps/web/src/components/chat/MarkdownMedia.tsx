import { memo, useState } from "react";
import { createPortal } from "react-dom";
import type { AssetResource, ScopedThreadRef } from "@t3tools/contracts";
import { isWorkspaceVideoPreviewPath } from "@t3tools/shared/filePreview";

import { useAssetUrlState } from "../../assets/assetUrls";
import { ExpandedImageDialog } from "./ExpandedImageDialog";

/** Sources the browser can load directly without a signed workspace asset URL. */
const DIRECT_MEDIA_SRC_PATTERN = /^(?:https?:|data:|blob:|\/\/)/i;

/** `markdownUrlTransform` escapes Windows drive paths as `/C:/…` so they survive sanitization. */
const ESCAPED_WINDOWS_DRIVE_PATH_PATTERN = /^\/[A-Za-z]:[\\/]/;

/** Paths that are absolute on either platform (after Windows-drive unescaping). */
const ABSOLUTE_PATH_PATTERN = /^(?:[/\\]|[A-Za-z]:[\\/])/;

const MEDIA_FRAME_CLASS_NAME =
  "my-2 block max-h-96 max-w-full rounded-lg border border-border/60 bg-background object-contain";

interface MarkdownMediaProps {
  src: string | undefined;
  alt?: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  /** Force the media kind; when omitted it is inferred from the file extension. */
  kind?: "image" | "video" | undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function mediaFileName(src: string): string {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
  const basename = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  return basename.length > 0 ? safeDecode(basename) : safeDecode(withoutQuery);
}

/**
 * Normalize a non-direct markdown src into a filesystem-style path: strip
 * query/fragment, decode percent escapes, and unescape the `/C:/…` form the
 * markdown URL transform uses to carry Windows drive paths through
 * sanitization.
 */
function mediaPathFromSrc(src: string): string {
  const withoutQuery = src.split(/[?#]/, 1)[0] ?? src;
  const decoded = safeDecode(withoutQuery);
  return ESCAPED_WINDOWS_DRIVE_PATH_PATTERN.test(decoded) ? decoded.slice(1) : decoded;
}

/**
 * Browser evidence artifacts (screenshots/recordings from the embedded
 * browser) are referenced by the absolute path the preview tools return,
 * e.g. `/…/userdata/browser-artifacts/browser-recording-x.webm`. They are
 * served by file name from the server's browser-artifacts directory. Only
 * absolute paths qualify — a workspace-relative path like
 * `docs/browser-artifacts/x.png` is an ordinary repo file.
 */
function browserArtifactFileName(path: string): string | null {
  if (!ABSOLUTE_PATH_PATTERN.test(path)) {
    return null;
  }
  const match = /[/\\]browser-artifacts[/\\]([^/\\]+)$/.exec(path);
  return match?.[1] ?? null;
}

function MediaUnavailable({ name }: { name: string }) {
  return (
    <span className="my-1 inline-flex max-w-full items-baseline gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
      Media unavailable:
      <span className="truncate font-mono">{name}</span>
    </span>
  );
}

function ResolvedMedia({ url, name, isVideo }: { url: string; name: string; isVideo: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (failedUrl === url) {
    return <MediaUnavailable name={name} />;
  }

  if (isVideo) {
    return (
      <video
        src={url}
        controls
        playsInline
        preload="metadata"
        aria-label={name}
        className={MEDIA_FRAME_CLASS_NAME}
        onError={() => setFailedUrl(url)}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        className="block max-w-full cursor-zoom-in"
        aria-label={`Expand image ${name}`}
        onClick={() => setExpanded(true)}
      >
        <img
          src={url}
          alt={name}
          loading="lazy"
          className={MEDIA_FRAME_CLASS_NAME}
          onError={() => setFailedUrl(url)}
        />
      </button>
      {expanded &&
        // Portal to the body: message rows create containing blocks that would
        // otherwise trap the fixed-position dialog inside the chat scroller.
        createPortal(
          <ExpandedImageDialog
            preview={{ images: [{ src: url, name }], index: 0 }}
            onClose={() => setExpanded(false)}
          />,
          document.body,
        )}
    </>
  );
}

function ResourceMedia({
  threadRef,
  resource,
  name,
  isVideo,
}: {
  threadRef: ScopedThreadRef;
  resource: AssetResource;
  name: string;
  isVideo: boolean;
}) {
  const assetUrl = useAssetUrlState(threadRef.environmentId, resource);

  if (assetUrl._tag === "Failure") {
    return <MediaUnavailable name={name} />;
  }
  if (assetUrl._tag === "Loading") {
    return (
      <span className="my-2 flex h-24 w-56 max-w-full animate-pulse items-center justify-center rounded-lg border border-border/40 bg-muted/30 px-2 text-xs text-muted-foreground">
        <span className="truncate">{name}</span>
      </span>
    );
  }
  return <ResolvedMedia url={assetUrl.url} name={name} isVideo={isVideo} />;
}

/**
 * Renders markdown-referenced media (images and videos) in chat messages.
 *
 * Workspace-relative sources are resolved to signed asset URLs for the
 * thread's worktree, so agents can save screenshots/recordings into the
 * workspace and embed them with plain markdown image syntax.
 */
export const MarkdownMedia = memo(function MarkdownMedia({
  src,
  alt,
  threadRef,
  kind,
}: MarkdownMediaProps) {
  if (!src) {
    return null;
  }
  const name = alt && alt.trim().length > 0 ? alt.trim() : mediaFileName(src);
  const isVideo = kind === "video" || (kind === undefined && isWorkspaceVideoPreviewPath(src));
  if (DIRECT_MEDIA_SRC_PATTERN.test(src)) {
    return <ResolvedMedia url={src} name={name} isVideo={isVideo} />;
  }
  if (!threadRef) {
    return <MediaUnavailable name={name} />;
  }
  const path = mediaPathFromSrc(src);
  const artifactFileName = browserArtifactFileName(path);
  const resource: AssetResource = artifactFileName
    ? { _tag: "browser-artifact", fileName: artifactFileName }
    : {
        _tag: "workspace-file",
        threadId: threadRef.threadId,
        path: path.startsWith("./") ? path.slice(2) : path,
      };
  return <ResourceMedia threadRef={threadRef} resource={resource} name={name} isVideo={isVideo} />;
});
