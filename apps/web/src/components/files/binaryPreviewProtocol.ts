import { ARCHIVE_MAX_BYTES } from "@t3tools/client-runtime/zip/bounded-zip";

export {
  ARCHIVE_ENTRY_MAX_BYTES,
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_RATIO,
} from "@t3tools/client-runtime/zip/bounded-zip";
export const BINARY_PREVIEW_MAX_BYTES = ARCHIVE_MAX_BYTES;
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
