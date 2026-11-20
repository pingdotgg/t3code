import { ARCHIVE_ENTRY_MAX_BYTES, boundedZip } from "@t3tools/client-runtime/zip/bounded-zip";
import JSZip from "jszip";

self.addEventListener("message", async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const entries = await boundedZip(event.data, ARCHIVE_ENTRY_MAX_BYTES);
    const archive = new JSZip();
    for (const [path, entry] of entries) {
      if (!entry.directory) archive.file(path, entry.bytes, { createFolders: false });
    }
    // ThreeMFLoader expects a ZIP and parses its XML with DOMParser on the main thread.
    const bytes = await archive.generateAsync({ type: "arraybuffer", compression: "STORE" });
    self.postMessage(bytes, { transfer: [bytes] });
  } catch {
    self.postMessage(null, { transfer: [] });
  }
});
