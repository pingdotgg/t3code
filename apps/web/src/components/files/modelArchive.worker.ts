import { unpackModelArchive } from "@t3tools/client-runtime/model-preview/archive";

self.addEventListener("message", async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const bytes = await unpackModelArchive(event.data);
    self.postMessage(bytes, { transfer: [bytes] });
  } catch {
    self.postMessage(null, { transfer: [] });
  }
});
