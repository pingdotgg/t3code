import { parseModelForTransfer } from "./modelWorkerParser";
import type { ModelPreviewFormat } from "@t3tools/shared/filePreview";
import type { TransferredModel } from "./modelTransfer";

export interface ModelWorkerRequest {
  bytes: ArrayBuffer;
  format: ModelPreviewFormat;
  basePath: string;
  revision: string | null;
}
export type ModelWorkerResponse =
  | { type: "loaded"; model: TransferredModel }
  | { type: "error"; message: string };

self.addEventListener("message", async (event: MessageEvent<ModelWorkerRequest>) => {
  try {
    const { bytes, format, basePath, revision } = event.data;
    const { payload, transfer } = await parseModelForTransfer(bytes, format, basePath, revision);
    self.postMessage({ type: "loaded", model: payload } satisfies ModelWorkerResponse, {
      transfer,
    });
  } catch (error) {
    const message = {
      type: "error",
      message: error instanceof Error ? error.message : "Could not parse this model.",
    } satisfies ModelWorkerResponse;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messages do not accept a target origin.
    self.postMessage(message);
  }
});
