import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as Base64 from "effect/encoding/Base64";

/**
 * A URL an `<img>` can show for an image taken out of an archive. SVG uses a data: URL, which
 * has an opaque origin wherever it is opened; other types use a blob: URL.
 */
export function archiveImageUrl(
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
): { readonly url: string; readonly revoke: () => void } {
  const mimeType =
    hostPreviewMimeTypeFromExtension(path.slice(path.lastIndexOf("."))) ??
    "application/octet-stream";
  if (mimeType === "image/svg+xml") {
    return { url: `data:${mimeType};base64,${Base64.encode(bytes)}`, revoke: () => undefined };
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  return { url, revoke: () => URL.revokeObjectURL(url) };
}
