import { ModelPreviewError } from "@t3tools/client-runtime/model-preview/error";
import { MAX_MODEL_BYTES } from "@t3tools/client-runtime/model-preview/annotations";
import { ModelScene } from "@t3tools/client-runtime/model-preview/scene";
import { ZipError, type ZipErrorCode } from "@t3tools/client-runtime/zip/error";
import type { ModelPreviewKind } from "@t3tools/shared/filePreview";

import { readBoundedDocument } from "./readBoundedDocument";

async function unpackInWorker(bytes: ArrayBuffer, signal: AbortSignal) {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./modelArchive.worker.ts", import.meta.url), {
    type: "module",
  });
  const listeners = new AbortController();
  try {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const options = { signal: listeners.signal };
      signal.addEventListener("abort", () => reject(signal.reason), options);
      worker.addEventListener("error", reject, options);
      worker.addEventListener(
        "message",
        (event: MessageEvent<ArrayBuffer | ZipErrorCode | null>) => {
          if (event.data instanceof ArrayBuffer) resolve(event.data);
          else if (event.data !== null) reject(new ZipError({ code: event.data }));
          else reject(new ModelPreviewError({ code: "model-invalid" }));
        },
        options,
      );
      worker.postMessage(bytes, [bytes]);
    });
  } finally {
    listeners.abort();
    worker.terminate();
  }
}

/** Fetches a model within the preview size limit and mounts it, unpacking 3MF off the main thread. */
export async function loadModelScene(input: {
  readonly container: HTMLElement;
  readonly src: string;
  readonly format: ModelPreviewKind;
  readonly signal: AbortSignal;
  readonly cache?: RequestCache;
}): Promise<ModelScene> {
  const bytes = await readBoundedDocument(input.src, input.signal, MAX_MODEL_BYTES, input.cache);
  return ModelScene.load({
    container: input.container,
    bytes,
    format: input.format,
    signal: input.signal,
    unpackArchive: unpackInWorker,
  });
}
