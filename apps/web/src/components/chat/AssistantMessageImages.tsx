import { memo, useState } from "react";
import { DownloadIcon, ImageOffIcon } from "lucide-react";

import { Button } from "../ui/button";

interface AssistantMessageImage {
  readonly id: string;
  readonly name: string;
  readonly previewUrl?: string;
  readonly previewUrlKind?: "asset";
  readonly previewError?: boolean;
}

interface AssistantMessageImagesProps {
  readonly images: ReadonlyArray<AssistantMessageImage>;
  readonly onExpand: (imageId: string) => void;
}

export function isSafeAssistantImagePreviewUrl(
  value: string,
  options?: { readonly trustedAsset?: boolean },
): boolean {
  const trimmed = value.trim();
  if (/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,]+)*;base64,/i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("/api/assets/")) {
    return true;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === "blob:") {
      return true;
    }
    return Boolean(
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname.startsWith("/api/assets/") &&
      options?.trustedAsset === true,
    );
  } catch {
    return false;
  }
}

const AssistantMessageImageCard = memo(function AssistantMessageImageCard({
  image,
  onExpand,
}: {
  readonly image: AssistantMessageImage;
  readonly onExpand: (imageId: string) => void;
}) {
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const previewUrl = image.previewUrl?.trim();
  const safePreviewUrl =
    previewUrl &&
    isSafeAssistantImagePreviewUrl(previewUrl, { trustedAsset: image.previewUrlKind === "asset" })
      ? previewUrl
      : undefined;

  if (image.previewError || (previewUrl && !safePreviewUrl)) {
    return (
      <div
        className="flex min-h-28 w-full max-w-xl items-center justify-center gap-2 rounded-xl border border-border/70 bg-muted/30 px-4 py-8 text-sm text-muted-foreground"
        role="alert"
      >
        <ImageOffIcon className="size-4" aria-hidden="true" />
        Image unavailable
      </div>
    );
  }

  if (!safePreviewUrl) {
    return (
      <div
        className="flex min-h-28 w-full max-w-xl items-center justify-center rounded-xl border border-border/70 bg-muted/30 px-4 py-8 text-sm text-muted-foreground"
        role="status"
      >
        Loading image…
      </div>
    );
  }

  return (
    <figure className="group/image relative w-fit max-w-full overflow-hidden rounded-xl border border-border/70 bg-muted/30">
      <button
        type="button"
        className="block max-w-full cursor-zoom-in"
        aria-label={`Expand ${image.name}`}
        onClick={() => onExpand(image.id)}
      >
        <img
          src={safePreviewUrl}
          alt={image.name}
          loading="lazy"
          className={`block h-auto max-h-[70vh] max-w-full object-contain ${loadState === "error" ? "hidden" : ""}`}
          onLoad={() => setLoadState("loaded")}
          onError={() => setLoadState("error")}
        />
      </button>
      {loadState === "loading" ? (
        <div
          className="pointer-events-none absolute inset-0 flex min-h-28 items-center justify-center bg-muted/80 px-4 py-8 text-sm text-muted-foreground"
          role="status"
        >
          Loading image…
        </div>
      ) : null}
      {loadState === "error" ? (
        <div
          className="flex min-h-28 items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground"
          role="alert"
        >
          <ImageOffIcon className="size-4" aria-hidden="true" />
          Image failed to load
        </div>
      ) : null}
      <Button
        render={
          <a
            href={safePreviewUrl}
            download={image.name}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
          />
        }
        size="icon-sm"
        variant="secondary"
        className="absolute bottom-2 right-2 z-10 opacity-100 shadow-sm transition-opacity pointer-fine:opacity-0 pointer-fine:focus-visible:opacity-100 pointer-fine:group-focus-within/image:opacity-100 pointer-fine:group-hover/image:opacity-100"
        aria-label={`Download ${image.name}`}
      >
        <DownloadIcon aria-hidden="true" />
      </Button>
    </figure>
  );
});

export const AssistantMessageImages = memo(function AssistantMessageImages({
  images,
  onExpand,
}: AssistantMessageImagesProps) {
  if (images.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 flex max-w-full flex-col items-start gap-2">
      {images.map((image) => (
        <AssistantMessageImageCard key={image.id} image={image} onExpand={onExpand} />
      ))}
    </div>
  );
});
