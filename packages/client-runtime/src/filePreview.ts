import {
  decodeFilePreviewText,
  FILE_TEXT_PREVIEW_MAX_BYTES,
  type ModelPreviewFormat,
} from "@t3tools/shared/filePreview";

/** Consume only a bounded prefix, even when a host ignores the requested HTTP range. */
export async function readFilePreviewResponse(
  response: Pick<Response, "ok" | "body">,
  signal: AbortSignal,
) {
  if (!response.ok) {
    // A streamed error body holds the connection open until GC otherwise.
    void response.body?.cancel().catch(() => undefined);
    throw new Error("The file could not be loaded. Reconnect and try again.");
  }
  if (signal.aborted) throw new Error("Preview cancelled.");
  const limit = FILE_TEXT_PREVIEW_MAX_BYTES + 1;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Streaming file previews are unavailable in this runtime.");
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      if (signal.aborted) throw new Error("Preview cancelled.");
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value.subarray(0, limit - length);
      chunks.push(chunk);
      length += chunk.length;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel();
  }
  if (signal.aborted) throw new Error("Preview cancelled.");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return decodeFilePreviewText(bytes);
}

/** What a 3D file's preview image shows, and why a file may have none. */
export function modelPreviewCopy(format: ModelPreviewFormat) {
  switch (format) {
    case "gltf":
      return {
        notice: "Rendered preview of the mesh, viewed from the front right.",
        unavailable:
          "This mesh could not be drawn. It may be empty, damaged, compressed, over 64 MB, or keep its data in separate .bin files.",
      };
    default:
      return {
        notice: "Rendered preview of the mesh, viewed from the front right.",
        unavailable: "This mesh could not be drawn. It may be empty, damaged, or over 64 MB.",
      };
  }
}
