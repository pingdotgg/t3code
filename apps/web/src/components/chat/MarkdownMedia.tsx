import type { AssetResource, ScopedThreadRef } from "@t3tools/contracts";
import {
  isDirectMarkdownMediaSource,
  isWorkspaceVideoPreviewPath,
  markdownMediaFileName,
  resolveMarkdownMediaSource,
} from "@t3tools/shared/filePreview";
import { memo, useState } from "react";
import { createPortal } from "react-dom";

import { useAssetUrlState } from "../../assets/assetUrls";
import { ExpandedImageDialog } from "./ExpandedImageDialog";

const MEDIA_FRAME_CLASS_NAME =
  "my-2 block max-h-96 max-w-full rounded-lg border border-border/60 bg-background object-contain";

interface MarkdownMediaProps {
  src: string | undefined;
  alt?: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  kind?: "image" | "video" | undefined;
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

export const MarkdownMedia = memo(function MarkdownMedia({
  src,
  alt,
  threadRef,
  kind,
}: MarkdownMediaProps) {
  if (!src) {
    return null;
  }
  const name = alt && alt.trim().length > 0 ? alt.trim() : markdownMediaFileName(src);
  const isVideo = kind === "video" || (kind === undefined && isWorkspaceVideoPreviewPath(src));
  if (isDirectMarkdownMediaSource(src)) {
    return <ResolvedMedia url={src} name={name} isVideo={isVideo} />;
  }
  if (!threadRef) {
    return <MediaUnavailable name={name} />;
  }
  const source = resolveMarkdownMediaSource(src, threadRef.threadId);
  return source._tag === "Asset" ? (
    <ResourceMedia threadRef={threadRef} resource={source.resource} name={name} isVideo={isVideo} />
  ) : (
    <ResolvedMedia url={source.url} name={name} isVideo={isVideo} />
  );
});
