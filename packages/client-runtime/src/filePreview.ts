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

/**
 * Copy for a 3D file's preview: what the image shows and its toggle's label, what the 3D view says
 * while loading and when the server cannot supply geometry, and why a file may have no image.
 */
export function modelPreviewCopy(format: ModelPreviewFormat) {
  switch (format) {
    case "blend":
      return {
        notice:
          "Blender's saved thumbnail, or a fresh render of the scene when the saved one is blank.",
        imageLabel: "Show thumbnail",
        loading: "Opening the scene in Blender…",
        viewerMissing: "Viewing .blend files in 3D needs Blender.",
        unavailable: "The file has no saved thumbnail, and Blender isn't installed to render one.",
      };
    case "gltf":
      return {
        notice: "Rendered preview of the mesh, viewed from the front right.",
        imageLabel: "Show preview image",
        loading: null,
        viewerMissing: "The file could not be loaded.",
        unavailable:
          "This mesh could not be drawn. It may be empty, damaged, compressed, over 64 MB, or keep its data in separate .bin files.",
      };
    default:
      return {
        notice: "Rendered preview of the mesh, viewed from the front right.",
        imageLabel: "Show preview image",
        loading: null,
        viewerMissing: "The file could not be loaded.",
        unavailable: "This mesh could not be drawn. It may be empty, damaged, or over 64 MB.",
      };
  }
}
