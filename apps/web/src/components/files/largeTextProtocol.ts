export const LARGE_TEXT_MAX_BYTES = 256 * 1024 * 1024;
export const LARGE_TEXT_MAX_ROWS = 5_000_000;
export const LARGE_TEXT_MAX_COLUMNS = 1024;
export const PREVIEW_PAGE_ROWS = 32;
export type TextPreviewRequest =
  | { type: "open"; src?: string; text?: string; sizeBytes?: number; delimiter: "," | "\t" | null }
  | { type: "page"; index: number }
  | { type: "copy" };
export type TextPreviewResult =
  | { type: "meta"; count: number; columns: number; complete: boolean; sizeBytes?: number }
  | { type: "page"; index: number; rows: string[][] }
  | { type: "copy"; text: string }
  | { type: "error"; operation: TextPreviewRequest["type"]; message: string };
