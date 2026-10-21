export const BINARY_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
export const ARCHIVE_ENTRY_MAX_BYTES = 10 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRIES = 2048;
export const ARCHIVE_MAX_RATIO = 200;
export const SQLITE_PAGE_SIZE = 50;

export interface ArchiveEntry {
  path: string;
  size: number;
  modified: string | null;
  directory: boolean;
}

export type BinaryWorkerRequest =
  | { type: "open"; kind: "archive" | "sqlite"; name: string; bytes: ArrayBuffer }
  | { type: "entry"; path: string }
  | { type: "rows"; table: string; page: number };

export type BinaryWorkerResult =
  | { type: "error"; message: string }
  | { type: "archive"; entries: ArchiveEntry[] }
  | { type: "entry"; path: string; bytes: Uint8Array<ArrayBuffer> }
  | { type: "sqlite"; tables: { name: string; count: number }[] }
  | { type: "rows"; table: string; page: number; columns: string[]; rows: string[][] };
