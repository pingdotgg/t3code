import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { useEffect, useState } from "react";

/** Upper-case extension used as the format label in media metadata lines ("MP4", "WAV"). */
export function mediaFormatLabel(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : null;
}

/** Whole-length label for a metadata line: "24s", "3m 12s", "1h 4m". */
export function formatMediaLength(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m ${total % 60}s`;
}

/** Playhead label: "0:07", "1:02:03", or "0:00.41" when the clip is short enough to need it. */
export function formatPlaybackTime(seconds: number, precise = false): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const secondsLabel = String(wholeSeconds).padStart(2, "0");
  const fraction = precise ? `.${String(Math.floor((safe % 1) * 100)).padStart(2, "0")}` : "";
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secondsLabel}${fraction}`
    : `${minutes}:${secondsLabel}${fraction}`;
}

/** Joins the known parts of a metadata line with the separator the redesign uses. */
export function mediaMetadataLine(
  parts: ReadonlyArray<string | null | undefined | false>,
): string | null {
  const known = parts.filter((part): part is string => typeof part === "string" && part !== "");
  return known.length > 0 ? known.join(" · ") : null;
}

export function formatMediaSize(sizeBytes: number | null): string | null {
  return sizeBytes === null ? null : formatAttachmentSize(sizeBytes);
}

/**
 * Byte size of a media asset from a HEAD request, which the asset route answers
 * without a body. Content-Length is readable cross-origin, so remote
 * environments report it too; any failure just leaves the size unknown.
 */
export function useMediaByteSize(url: string | null): number | null {
  const [size, setSize] = useState<{ url: string; bytes: number | null } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read external asset size with an abortable HEAD request scoped to the current URL.
  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    void fetch(url, { method: "HEAD", signal: controller.signal })
      .then((response) => {
        const length = response.ok ? Number(response.headers.get("content-length")) : Number.NaN;
        setSize({ url, bytes: Number.isFinite(length) && length > 0 ? length : null });
      })
      .catch(() => {
        if (!controller.signal.aborted) setSize({ url, bytes: null });
      });
    return () => controller.abort();
  }, [url]);
  return size?.url === url ? size.bytes : null;
}
