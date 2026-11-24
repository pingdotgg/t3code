import {
  type BitmapEncodeOptions,
  type ReencodeBitmapOptions,
  type ReencodeResult,
  encodeBitmapOnCanvas,
  reencodeBitmapWithinBudgetOnCanvas,
} from "./imageCompressionCodec";

export type ImageCompressionWorkerRequest =
  | {
      id: number;
      kind: "encode";
      bitmap: ImageBitmap;
      options: BitmapEncodeOptions;
      thumbnailOptions?: BitmapEncodeOptions | null;
    }
  | {
      id: number;
      kind: "reencode";
      bitmap: ImageBitmap;
      options: ReencodeBitmapOptions;
    };

export type ImageCompressionWorkerResponse =
  | { id: number; kind: "thumbnail"; blob: Blob | null }
  | { id: number; kind: "encode-result"; blob: Blob | null }
  | { id: number; kind: "reencode-result"; result: ReencodeResult }
  | { id: number; kind: "error" };

function postResponse(response: ImageCompressionWorkerResponse) {
  self.postMessage(response, { transfer: [] });
}

async function handleRequest(request: ImageCompressionWorkerRequest): Promise<void> {
  try {
    if (request.kind === "reencode") {
      const result = await reencodeBitmapWithinBudgetOnCanvas(request.bitmap, request.options);
      postResponse({ id: request.id, kind: "reencode-result", result });
      return;
    }
    const mainEncode = encodeBitmapOnCanvas(request.bitmap, request.options);
    const thumbnailEncode = request.thumbnailOptions
      ? encodeBitmapOnCanvas(request.bitmap, request.thumbnailOptions)
          .catch(() => null)
          .then((blob) => {
            postResponse({ id: request.id, kind: "thumbnail", blob });
          })
      : Promise.resolve();
    const [mainResult] = await Promise.allSettled([mainEncode, thumbnailEncode]);
    if (mainResult.status === "fulfilled") {
      postResponse({ id: request.id, kind: "encode-result", blob: mainResult.value });
    } else {
      postResponse({ id: request.id, kind: "error" });
    }
  } catch {
    postResponse({ id: request.id, kind: "error" });
  } finally {
    request.bitmap.close();
  }
}

self.addEventListener("message", (event: MessageEvent<ImageCompressionWorkerRequest>) => {
  void handleRequest(event.data);
});
