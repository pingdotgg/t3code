/** Mesh files above this size show the preview image; the 3D view downloads files whole. */
export const MODEL_VIEWER_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Reads a response body, failing once it passes `limit` bytes. `notFound` explains a 404, which
 * for `.blend` geometry means the server has no Blender to export it.
 */
export async function readModelBytes(
  response: Pick<Response, "ok" | "status" | "body">,
  limit: number,
  signal: AbortSignal,
  notFound = "The file could not be loaded.",
) {
  if (response.status === 404) throw new Error(notFound);
  if (!response.ok || !response.body) throw new Error("The file could not be loaded.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit) throw new Error("This file is too large for the 3D view.");
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
