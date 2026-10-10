import type { ModelWorkerRequest, ModelWorkerResponse } from "./model.worker";
import type { TransferredModel } from "./modelTransfer";
import type { ModelPreviewFormat } from "@t3tools/shared/filePreview";

/** One job per worker allows an obsolete synchronous parse to be stopped immediately. */
export function parseModelInWorker(
  bytes: ArrayBuffer,
  format: ModelPreviewFormat,
  basePath: string,
  signal: AbortSignal,
  revision: string | null = null,
) {
  return new Promise<TransferredModel>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Model loading was cancelled.", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("./model.worker.ts", import.meta.url), { type: "module" });
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(new DOMException("Model loading was cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const onMessage = (event: MessageEvent<ModelWorkerResponse>) => {
      finish();
      if (event.data.type === "loaded") resolve(event.data.model);
      else reject(new Error(event.data.message));
    };
    const onError = (event: ErrorEvent) => {
      event.preventDefault();
      finish();
      reject(new Error(event.message || "The model loading worker failed."));
    };
    const onMessageError = () => {
      finish();
      reject(new Error("Could not receive the parsed model."));
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    try {
      worker.postMessage({ bytes, format, basePath, revision } satisfies ModelWorkerRequest, [
        bytes,
      ]);
    } catch (error) {
      finish();
      reject(error);
    }
  });
}
