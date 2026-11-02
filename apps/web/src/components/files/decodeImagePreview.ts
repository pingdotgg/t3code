import { readBinaryPreview } from "./readBinaryPreview";

import { translateNow } from "../media/translateNow";
export async function decodeImagePreview(src: string, heif: boolean, signal: AbortSignal) {
  const worker = new Worker(new URL("./imageDecode.worker.ts", import.meta.url), {
    type: "module",
  });
  const controller = new AbortController();
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const fail = (message: string) => reject(new Error(message));
      const abort = () => fail(translateNow("review.extra.image.decoding.cancelled"));
      signal.addEventListener("abort", abort, { signal: controller.signal });
      if (signal.aborted) return abort();
      const timer = setTimeout(
        () => fail(translateNow("review.extra.this.image.took.too.long.to.decode")),
        30_000,
      );
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      worker.addEventListener("error", () =>
        fail(translateNow("review.extra.could.not.load.the.image.decoder")),
      );
      worker.addEventListener("message", (event: MessageEvent<{ blob?: Blob; error?: string }>) => {
        if (event.data.blob) resolve(event.data.blob);
        else fail(event.data.error ?? translateNow("review.extra.could.not.decode.this.image"));
      });
      void readBinaryPreview(src, controller.signal).then(
        (bytes) => worker.postMessage({ bytes, heif }, [bytes]),
        reject,
      );
    });
  } finally {
    controller.abort();
    worker.terminate();
  }
}
