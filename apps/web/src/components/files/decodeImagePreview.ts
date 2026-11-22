import { msg } from "gt-react";

import { m } from "~/i18n/messages";

import type { PreviewFailure } from "./previewFailure";
import { previewFailureText } from "./previewFailureMessages";
import { readBinaryPreview } from "./readBinaryPreview";

export async function decodeImagePreview(src: string, heif: boolean, signal: AbortSignal) {
  const worker = new Worker(new URL("./imageDecode.worker.ts", import.meta.url), {
    type: "module",
  });
  const controller = new AbortController();
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const fail = (message: string) => reject(new Error(message));
      const abort = () => fail(m(msg("Image decoding cancelled.")));
      signal.addEventListener("abort", abort, { signal: controller.signal });
      if (signal.aborted) return abort();
      const timer = setTimeout(() => fail(m(msg("This image took too long to decode."))), 30_000);
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      worker.addEventListener("error", () => fail(m(msg("Could not load the image decoder."))));
      worker.addEventListener(
        "message",
        (event: MessageEvent<{ blob?: Blob; failure?: PreviewFailure }>) => {
          if (event.data.blob) resolve(event.data.blob);
          else if (event.data.failure) fail(previewFailureText(event.data.failure, m));
          else fail(m(msg("Could not decode this image.")));
        },
      );
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
