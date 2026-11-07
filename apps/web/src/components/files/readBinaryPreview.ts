import { BINARY_PREVIEW_MAX_BYTES } from "./binaryPreviewProtocol";

import { translateNow } from "../media/translateNow";
export async function readBinaryPreview(src: string, signal: AbortSignal) {
  const response = await fetch(src, { signal });
  if (!response.ok)
    throw new Error(translateNow("review.extra.the.file.could.not.be.loaded.close.it"));
  if (Number(response.headers.get("content-length")) > BINARY_PREVIEW_MAX_BYTES)
    throw new Error(translateNow("review.extra.preview.limited.to.files.under.50.mb"));
  const reader = response.body?.getReader();
  if (!reader) throw new Error(translateNow("review.extra.the.file.is.unavailable"));
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > BINARY_PREVIEW_MAX_BYTES)
        throw new Error(translateNow("review.extra.preview.limited.to.files.under.50.mb"));
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Blob(chunks).arrayBuffer();
}
