export async function readBoundedDocument(
  src: string,
  signal: AbortSignal,
  limit: number,
  cache: RequestCache = "default",
) {
  const response = await fetch(src, { signal, cache });
  if (!response.ok || Number(response.headers.get("content-length")) > limit)
    throw new Error("This file is unavailable or too large to preview.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("This file is unavailable.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("This file is too large to preview.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new Blob(chunks).arrayBuffer();
}
