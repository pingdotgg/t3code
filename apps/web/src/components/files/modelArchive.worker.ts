import { unpackModelArchive } from "@t3tools/client-runtime/model-preview/archive";
import { isZipError } from "@t3tools/client-runtime/zip/error";

self.addEventListener("message", async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const bytes = await unpackModelArchive(event.data);
    self.postMessage(bytes, { transfer: [bytes] });
  } catch (cause) {
    self.postMessage(isZipError(cause) ? cause.code : null);
  }
});
