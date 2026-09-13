import { DownloadIcon, ExternalLinkIcon } from "lucide-react";

import { resolveExternalWebLinkHost } from "../chat/externalLinkContextMenu";
import { Button } from "../ui/button";
import { resolveProtocolRelativeMediaUrl } from "./mediaContent";

/** Navigates directly so the browser handles video playback and downloads, without fetching bytes. */
export function OpenMediaLink(props: {
  readonly originalUrl?: string | undefined;
  readonly src?: string | null | undefined;
  readonly fileName?: string | undefined;
  readonly className?: string | undefined;
}) {
  const originalUrl =
    resolveExternalWebLinkHost(props.originalUrl) !== null ? props.originalUrl : undefined;
  const source = originalUrl ?? props.src;
  if (!source) return null;
  const url = resolveProtocolRelativeMediaUrl(source);
  let isBlob = false;
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== "http:" && protocol !== "https:" && protocol !== "blob:") return null;
    isBlob = protocol === "blob:";
  } catch {
    return null;
  }
  return (
    <Button
      size="sm"
      variant="secondary"
      className={props.className}
      render={
        <a
          href={url}
          target={isBlob ? undefined : "_blank"}
          download={isBlob ? props.fileName || true : undefined}
          rel="noopener noreferrer"
        />
      }
    >
      {isBlob ? <DownloadIcon /> : <ExternalLinkIcon />}
      {originalUrl ? "Open original" : isBlob ? "Download video" : "Open in browser"}
    </Button>
  );
}
