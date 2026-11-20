import * as Schema from "effect/Schema";
import type {
  ModelCameraView,
  ModelNote,
  ModelPinCapture,
  Vec3,
} from "@t3tools/client-runtime/model-preview/annotations";
import type { ModelPreviewErrorCode } from "@t3tools/client-runtime/model-preview/error";
import type { ModelViewPreset } from "@t3tools/client-runtime/model-preview/scene";
import type { ZipErrorCode } from "@t3tools/client-runtime/zip/error";
import type { ModelPreviewKind } from "@t3tools/shared/filePreview";

// Shared by the native screen and the WebView page script.

export interface ModelSummary {
  readonly format: ModelPreviewKind;
  readonly triangles: number;
  readonly size: Vec3;
  readonly fingerprint: string;
}

export interface ModelViewerColors {
  readonly background: string;
  readonly pin: string;
  readonly pinText: string;
  readonly ring: string;
}

/** Native to page, through `T3ModelViewer.command`. */
export type ModelViewerCommand =
  | { readonly type: "theme"; readonly colors: ModelViewerColors }
  /** Starts a load; a newer `id` replaces any load still in flight. */
  | { readonly type: "begin"; readonly id: number }
  /** Base64 bytes. The page acks each one before native sends the next. */
  | { readonly type: "chunk"; readonly id: number; readonly data: string }
  | {
      readonly type: "end";
      readonly id: number;
      readonly format: ModelPreviewKind;
      readonly view: ModelCameraView | null;
    }
  | { readonly type: "cancel"; readonly id: number }
  | { readonly type: "preset"; readonly preset: ModelViewPreset | "fit" }
  | { readonly type: "view"; readonly view: ModelCameraView }
  | { readonly type: "wireframe"; readonly on: boolean }
  | { readonly type: "annotate"; readonly on: boolean }
  | {
      readonly type: "notes";
      readonly notes: ReadonlyArray<ModelNote>;
      readonly activeId: string | null;
      /** A pin placed but not saved yet, shown with the next number. */
      readonly draft: Pick<ModelNote, "point" | "normal" | "number"> | null;
    }
  | {
      readonly type: "capture";
      readonly id: number;
      readonly requestId: number;
      readonly notes: ReadonlyArray<ModelNote>;
    };

/** Page to native, through `ReactNativeWebView.postMessage`. */
export type ModelViewerEvent =
  | { readonly type: "ready" }
  | { readonly type: "crashed" }
  | { readonly type: "ack"; readonly id: number }
  | {
      readonly type: "loaded";
      readonly id: number;
      readonly summary: ModelSummary;
      readonly view: ModelCameraView;
    }
  | {
      readonly type: "failed";
      readonly id: number;
      readonly code: ModelPreviewErrorCode | ZipErrorCode;
    }
  /** The camera after a gesture (`moved`) or after a preset or restored view. */
  | { readonly type: "view"; readonly view: ModelCameraView; readonly moved: boolean }
  | {
      readonly type: "pick";
      readonly hit: { readonly point: Vec3; readonly normal: Vec3; readonly face: number };
    }
  | { readonly type: "pin"; readonly id: string }
  | {
      readonly type: "captured";
      readonly id: number;
      readonly requestId: number;
      readonly result: ModelPinCapture | null;
    };

const MODEL_VIEWER_REPLY_TIMEOUT_MS = 15_000;
const MODEL_VIEWER_LOAD_TIMEOUT_MS = 45_000;

/** One load owns its replies. Closing it cancels transfer and settles any pending capture. */
export function createModelViewerRequests(
  id: number,
  post: (input: ModelViewerCommand) => boolean,
) {
  const controller = new AbortController();
  let settleChunk: ((error?: unknown) => void) | null = null;
  let settleLoad: ((error?: unknown) => void) | null = null;
  let chunkError: Error | null = null;
  let nextCaptureId = 0;
  let pendingCapture: {
    requestId: number;
    settle: (result: ModelPinCapture | null) => void;
  } | null = null;
  return {
    id,
    signal: controller.signal,
    sendChunk(data: string) {
      return new Promise<void>((resolve, reject) => {
        controller.signal.throwIfAborted();
        if (chunkError) throw chunkError;
        if (settleChunk)
          throw new Error("The model viewer has not acknowledged the previous chunk.");
        const timeout = setTimeout(() => {
          // An ack only carries the load ID, so no further chunks can use this load.
          chunkError = new Error("The model viewer timed out receiving a chunk.");
          settleChunk?.(chunkError);
        }, MODEL_VIEWER_REPLY_TIMEOUT_MS);
        settleChunk = (error) => {
          clearTimeout(timeout);
          settleChunk = null;
          if (error === undefined) resolve();
          else reject(error);
        };
        if (!post({ type: "chunk", id, data })) {
          settleChunk?.(new Error("The model viewer is unavailable."));
        }
      });
    },
    finish(format: ModelPreviewKind, view: ModelCameraView | null) {
      return new Promise<void>((resolve, reject) => {
        controller.signal.throwIfAborted();
        if (settleLoad) throw new Error("The model viewer is still loading.");
        const timeout = setTimeout(
          () => settleLoad?.(new Error("The model viewer timed out loading the model.")),
          MODEL_VIEWER_LOAD_TIMEOUT_MS,
        );
        settleLoad = (error) => {
          clearTimeout(timeout);
          settleLoad = null;
          if (error === undefined) resolve();
          else reject(error);
        };
        if (!post({ type: "end", id, format, view })) {
          settleLoad?.(new Error("The model viewer is unavailable."));
        }
      });
    },
    capture(notes: ReadonlyArray<ModelNote>) {
      return new Promise<ModelPinCapture | null>((resolve) => {
        if (controller.signal.aborted || pendingCapture) {
          resolve(null);
          return;
        }
        const requestId = ++nextCaptureId;
        const settle = (result: ModelPinCapture | null) => {
          clearTimeout(timeout);
          pendingCapture = null;
          resolve(result);
        };
        const timeout = setTimeout(() => settle(null), MODEL_VIEWER_REPLY_TIMEOUT_MS);
        pendingCapture = { requestId, settle };
        if (!post({ type: "capture", id, requestId, notes })) pendingCapture?.settle(null);
      });
    },
    receive(event: Extract<ModelViewerEvent, { type: "ack" | "captured" | "loaded" }>) {
      if (event.id !== id) return;
      if (event.type === "ack") {
        settleChunk?.();
      } else if (event.type === "loaded") {
        settleLoad?.();
      } else if (pendingCapture?.requestId === event.requestId) {
        pendingCapture.settle(event.result);
      }
    },
    close() {
      controller.abort();
      settleChunk?.(controller.signal.reason);
      settleLoad?.(controller.signal.reason);
      pendingCapture?.settle(null);
    },
  };
}

/** Raw bytes per bridge message; base64 makes each a third larger. */
const MODEL_TRANSFER_CHUNK_BYTES = 256 * 1024;

export class ModelTooLargeError extends Schema.TaggedError<ModelTooLargeError>()(
  "ModelTooLargeError",
  {},
) {
  override get message() {
    return "The 3D model is larger than the preview limit.";
  }
}

export const isModelTooLargeError = Schema.is(ModelTooLargeError);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Re-chunks a byte stream into base64 messages of a fixed size, refusing it once it passes
 * `limit`. The caller pulls one message at a time, so a slow page holds back the read.
 */
export async function* modelTransferChunks(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array | undefined }> },
  limit: number,
  chunkBytes = MODEL_TRANSFER_CHUNK_BYTES,
): AsyncGenerator<string, void, undefined> {
  const pending = new Uint8Array(chunkBytes);
  let filled = 0;
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > limit) throw new ModelTooLargeError();
    let offset = 0;
    while (offset < value.length) {
      const taken = Math.min(chunkBytes - filled, value.length - offset);
      pending.set(value.subarray(offset, offset + taken), filled);
      filled += taken;
      offset += taken;
      if (filled === chunkBytes) {
        yield bytesToBase64(pending);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield bytesToBase64(pending.subarray(0, filled));
}

/** Collects decoded chunks on the page, within the same bound native enforces. */
export function createModelByteSink(limit: number) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  return {
    push(data: string) {
      const bytes = base64ToBytes(data);
      size += bytes.length;
      if (size > limit) throw new ModelTooLargeError();
      chunks.push(bytes);
    },
    bytes(): ArrayBuffer {
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      chunks.length = 0;
      return joined.buffer;
    },
  };
}
