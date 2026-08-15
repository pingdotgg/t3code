import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";

import { ExpandedImageDialog } from "./ExpandedImageDialog";

export function ChatRemoteImage(props: {
  readonly src: string;
  readonly alt: string;
  readonly className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const name = props.alt.trim().length > 0 ? props.alt : "Image";

  if (failed) {
    return (
      <div className="my-2 rounded-lg border border-border/80 bg-background/70 px-3 py-2 text-secondary-label text-xs">
        Unable to load image{props.alt ? ` “${props.alt}”` : ""}.
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className={cn(
          "my-2 block max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/80 bg-background/70",
          props.className,
        )}
        aria-label={`Preview ${name}`}
        onClick={() => setExpanded(true)}
      >
        <img
          src={props.src}
          alt={name}
          className="block h-auto max-h-[360px] max-w-full object-contain"
          onError={() => setFailed(true)}
        />
      </button>
      {expanded ? (
        <ExpandedImageDialog
          preview={{ images: [{ src: props.src, name }], index: 0 }}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </>
  );
}

export function ChatWorkspaceImage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly path: string;
  readonly alt: string;
  readonly className?: string;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, {
    _tag: "workspace-file",
    threadId: props.threadRef.threadId,
    path: props.path,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const name = props.alt.trim().length > 0 ? props.alt : fileNameFromPath(props.path);

  if (assetUrl._tag === "Failure" || (assetUrl._tag === "Success" && failedUrl === assetUrl.url)) {
    return (
      <div className="my-2 rounded-lg border border-border/80 bg-background/70 px-3 py-2 text-secondary-label text-xs">
        Unable to load image{name ? ` “${name}”` : ""}.
      </div>
    );
  }

  if (assetUrl._tag !== "Success") {
    return (
      <div className="my-2 flex min-h-[120px] items-center justify-center rounded-lg border border-border/80 bg-background/70 text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className={cn(
          "my-2 block max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/80 bg-background/70",
          props.className,
        )}
        aria-label={`Preview ${name}`}
        onClick={() => setExpanded(true)}
      >
        <img
          src={assetUrl.url}
          alt={name}
          className="block h-auto max-h-[360px] max-w-full object-contain"
          onError={() => setFailedUrl(assetUrl.url)}
        />
      </button>
      {expanded ? (
        <ExpandedImageDialog
          preview={{ images: [{ src: assetUrl.url, name }], index: 0 }}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </>
  );
}

function fileNameFromPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}
