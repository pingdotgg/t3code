import JSZip from "jszip";

import { ARCHIVE_ENTRY_MAX_BYTES, boundedZip } from "../zip/boundedZip.ts";

/**
 * Re-packs a 3MF within the archive limits as an uncompressed ZIP, which ThreeMFLoader then
 * reads on the thread that owns the DOM. Web runs this in a worker; it is pure, so it runs anywhere.
 */
export async function unpackModelArchive(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const entries = await boundedZip(bytes, ARCHIVE_ENTRY_MAX_BYTES);
  const archive = new JSZip();
  for (const [path, entry] of entries) {
    if (!entry.directory) archive.file(path, entry.bytes, { createFolders: false });
  }
  return archive.generateAsync({ type: "arraybuffer", compression: "STORE" });
}
