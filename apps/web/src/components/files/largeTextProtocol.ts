import type { PreviewFailure } from "./previewFailure";
export const LARGE_TEXT_MAX_BYTES = 256 * 1024 * 1024;
export const LARGE_TEXT_MAX_ROWS = 5_000_000;
export const LARGE_TEXT_MAX_COLUMNS = 1024;
export const PREVIEW_PAGE_ROWS = 32;
// Browsers stop laying out an element near 33.5M px. Rendered Markdown measured about 22 px per
// source line, so files taller than this stay in the scaled plain viewer.
export const RENDERED_MAX_LINES = 1_200_000;
// Rendered Markdown and highlighted source hold the whole file on the main thread; larger files
// use the worker-backed plain viewer.
export const FULL_TEXT_MAX_BYTES = 64 * 1024 * 1024;
export type TextPreviewRequest =
  | { type: "open"; src?: string; text?: string; sizeBytes?: number; delimiter: "," | "\t" | null }
  | { type: "page"; index: number }
  | { type: "copy" };
export type TextPreviewResult =
  | {
      type: "meta";
      count: number;
      columns: number;
      columnsTruncated: boolean;
      complete: boolean;
      sizeBytes?: number;
    }
  | { type: "page"; index: number; rows: string[][] }
  | { type: "copy"; text: string }
  | ({ type: "error"; operation: TextPreviewRequest["type"] } & PreviewFailure);
