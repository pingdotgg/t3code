import { decodeFilePreviewText } from "@t3tools/shared/filePreview";
import {
  checkZipArchiveSize,
  loadZipArchive,
  readZipArchiveStream,
  withZipAbort,
  type ZipPreviewEntry,
} from "@t3tools/client-runtime/zip-preview";

export { ZipPreviewError } from "@t3tools/client-runtime/zip-preview";

export type { ZipPreviewEntry } from "@t3tools/client-runtime/zip-preview";

export async function readZipPreviewResponse(
  response: Pick<Response, "ok" | "body">,
  signal: AbortSignal,
  onProgress?: (receivedBytes: number) => void,
): Promise<Blob> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    throw new Error("Could not load this ZIP file.");
  }
  return new Blob([await readZipArchiveStream(response.body, signal, onProgress)], {
    type: "application/zip",
  });
}

export async function loadZipPreview(blob: Blob, signal: AbortSignal) {
  signal.throwIfAborted();
  checkZipArchiveSize(blob.size);
  const archive = await loadZipArchive(
    new Uint8Array(await withZipAbort(blob.arrayBuffer(), signal)),
    signal,
  );
  return {
    ...archive,
    async readTextPrefix(entry: ZipPreviewEntry, fileSignal: AbortSignal) {
      const { bytes, truncated } = await archive.readTextPrefix(entry, fileSignal);
      return decodeFilePreviewText(bytes, truncated);
    },
    async readFile(entry: ZipPreviewEntry, fileSignal: AbortSignal) {
      return new Blob([await archive.readFile(entry, fileSignal)], {
        type: entry.mimeType ?? "application/octet-stream",
      });
    },
    async readFileForSave(entry: ZipPreviewEntry, fileSignal: AbortSignal) {
      return new Blob([await archive.readFileForSave(entry, fileSignal)], {
        type: entry.mimeType ?? "application/octet-stream",
      });
    },
  };
}
