import { expect, it } from "vite-plus/test";
import workerUrl from "./imageDecode.worker.ts?worker&url";
import photoUrl from "../../../test/fixtures/images/photo.heic?url";

it("decodes HEIC under the desktop content security policy", async () => {
  const bytes = await (await fetch(photoUrl)).arrayBuffer();
  const frame = document.createElement("iframe");
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:"><script>
    onmessage = async ({ data }) => {
      const url = URL.createObjectURL(new Blob(['import ' + JSON.stringify(data.workerUrl)], { type: 'text/javascript' }));
      const worker = new Worker(url, { type: 'module' });
      worker.onmessage = ({ data }) => {
        parent.postMessage(data, '*');
        worker.terminate();
        URL.revokeObjectURL(url);
      };
      worker.onerror = (event) => parent.postMessage({ error: event.message }, '*');
      worker.postMessage({ bytes: data.bytes, heif: true }, [data.bytes]);
    };
  </script>`;
  const controller = new AbortController();
  try {
    const loaded = new Promise<void>((resolve) =>
      frame.addEventListener("load", () => resolve(), { once: true }),
    );
    document.body.append(frame);
    await loaded;
    const decoded = new Promise<{ blob?: Blob; error?: string }>((resolve) => {
      window.addEventListener(
        "message",
        (event) => {
          if (event.source === frame.contentWindow) resolve(event.data);
        },
        { signal: controller.signal },
      );
    });
    frame.contentWindow!.postMessage(
      { bytes, workerUrl: new URL(workerUrl, location.href).href },
      "*",
      [bytes],
    );
    const result = await decoded;
    expect(result.error).toBeUndefined();
    expect(result.blob?.type).toBe("image/png");
    const bitmap = await createImageBitmap(result.blob!);
    expect([bitmap.width, bitmap.height]).toEqual([128, 128]);
    bitmap.close();
  } finally {
    controller.abort();
    frame.remove();
  }
});
