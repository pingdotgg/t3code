import type {
  PrinterAction,
  PrinterConfig,
  PrinterError,
  PrinterOperationError,
  PrinterSnapshot,
  PrinterTestConnectionResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";

/** Derives a stable per-job-instance start timestamp for backends without a native job ID. */
export function deriveStableJobStartedAt(options: {
  readonly isActive: boolean;
  readonly fileName: string | null;
  readonly elapsedSeconds: number | null;
  readonly previous: PrinterSnapshot | undefined;
  readonly nowMs: number;
}): string | null {
  if (!options.isActive) return null;
  const prevJob = options.previous?.job;
  const prevWasActive =
    prevJob !== undefined &&
    (prevJob.status === "running" || prevJob.status === "pause" || prevJob.status === "prepare");
  const elapsedReset =
    options.elapsedSeconds !== null &&
    prevJob?.elapsedSeconds !== null &&
    prevJob?.elapsedSeconds !== undefined &&
    options.elapsedSeconds + 5 < prevJob.elapsedSeconds;
  if (
    prevWasActive &&
    prevJob.fileName === options.fileName &&
    prevJob.startedAt !== null &&
    !elapsedReset
  ) {
    return prevJob.startedAt;
  }
  const offsetMs = options.elapsedSeconds !== null ? Math.max(0, options.elapsedSeconds) * 1000 : 0;
  return DateTime.formatIso(DateTime.makeUnsafe(Math.max(0, options.nowMs - offsetMs)));
}

export type PrinterMediaAssetKind = "camera" | "cover" | "pick";

export interface PrinterMediaAsset {
  readonly bytes: Uint8Array;
  readonly contentType: "image/jpeg" | "image/png";
  readonly capturedAt: string;
  readonly stale: boolean;
  readonly online: boolean;
  readonly hash: string;
}

export interface PrinterRuntimeCache {
  readonly entityPrefix?: string;
  readonly deviceId?: string;
  readonly deviceIdPrefix?: string;
  readonly cameraEntityHealthy?: boolean;
  readonly lastCameraHash?: string;
  readonly lastCameraChangedAtMs?: number;
  readonly lastCompletedJobName?: string | null;
}

export interface PrinterPollOutput {
  readonly snapshot: PrinterSnapshot;
  readonly cache: PrinterRuntimeCache;
}

export interface PrinterAdapter<TConfig extends PrinterConfig = PrinterConfig> {
  readonly poll: (
    config: TConfig,
    secret: string,
    previous: PrinterSnapshot | undefined,
    cache: PrinterRuntimeCache,
  ) => Effect.Effect<PrinterPollOutput, PrinterOperationError, HttpClient.HttpClient>;
  readonly testConnection: (
    config: TConfig,
    secret: string,
  ) => Effect.Effect<PrinterTestConnectionResult, PrinterOperationError, HttpClient.HttpClient>;
  readonly executeAction: (
    config: TConfig,
    secret: string,
    action: PrinterAction,
    current: PrinterSnapshot,
    cache: PrinterRuntimeCache,
  ) => Effect.Effect<void, PrinterError, HttpClient.HttpClient>;
  readonly fetchMedia: (
    config: TConfig,
    secret: string,
    kind: PrinterMediaAssetKind,
    current: PrinterSnapshot | undefined,
    cache: PrinterRuntimeCache,
  ) => Effect.Effect<
    { readonly asset: PrinterMediaAsset; readonly cache: PrinterRuntimeCache },
    PrinterOperationError,
    HttpClient.HttpClient
  >;
}

export function imageDimensions(
  bytes: Uint8Array,
  mimeType: "image/jpeg" | "image/png",
): { readonly width: number; readonly height: number } {
  if (mimeType === "image/png" && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
  }
  if (mimeType === "image/jpeg" && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      offset += 2;
      if (marker === 0xd9 || marker === 0xda) break;
      const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
        const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
        return { width, height };
      }
      offset += segmentLength;
    }
  }
  return { width: 0, height: 0 };
}

export function detectImageMimeType(bytes: Uint8Array): "image/jpeg" | "image/png" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}
