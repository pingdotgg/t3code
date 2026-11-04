// @effect-diagnostics nodeBuiltinImport:off - Previews read from the FileHandle the caller
// validated, so the file cannot be swapped between the identity check and the read.
import type * as NodeFSP from "node:fs/promises";

import type { ModelPreviewFormat } from "@t3tools/shared/filePreview";
import { parseMesh } from "@t3tools/shared/meshFiles";

import { renderMesh } from "./meshRender.ts";
import { encodeRgbaPng } from "./rgbaPng.ts";

/** Geometry is parsed whole, so mesh files above this size get no preview. */
const MESH_PREVIEW_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MESH_PREVIEW_MAX_TRIANGLES = 2_000_000;

async function readWhole(handle: NodeFSP.FileHandle, size: number) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return bytes.subarray(0, offset);
}

/** PNG render of a mesh file's geometry, or `null` when the file has nothing to show. */
export async function modelPreviewPng(
  format: ModelPreviewFormat,
  handle: NodeFSP.FileHandle,
  size: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (size > MESH_PREVIEW_MAX_INPUT_BYTES) return null;
  const mesh = await parseMesh(
    format,
    await readWhole(handle, size),
    { maxTriangles: MESH_PREVIEW_MAX_TRIANGLES },
    signal,
  );
  signal.throwIfAborted();
  const image = mesh ? await renderMesh(mesh, signal) : null;
  signal.throwIfAborted();
  return image ? encodeRgbaPng(image.width, image.height, image.rgba) : null;
}
