import type { PreviewFailure } from "./previewFailure";
import { ARCHIVE_MAX_BYTES } from "@t3tools/client-runtime/zip/bounded-zip";

export {
  ARCHIVE_ENTRY_MAX_BYTES,
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_RATIO,
} from "@t3tools/client-runtime/zip/bounded-zip";
export const BINARY_PREVIEW_MAX_BYTES = ARCHIVE_MAX_BYTES;
export const SQLITE_PAGE_SIZE = 50;

const ARCHIVE_WALL_CLOCK_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/;

export function formatArchiveModifiedDate(
  modified: string | null,
  locales?: Intl.LocalesArgument,
): string {
  if (!modified) return "-";
  const wallClock = ARCHIVE_WALL_CLOCK_DATE.exec(modified);
  if (wallClock) {
    const [, year, month, day] = wallClock;
    const date = new Date(0);
    date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    return date.toLocaleDateString(locales, { timeZone: "UTC" });
  }
  const date = new Date(modified);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString(locales);
}

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
  | ({ type: "error" } & PreviewFailure)
  | { type: "archive"; entries: ArchiveEntry[] }
  | { type: "entry"; path: string; bytes: Uint8Array<ArrayBuffer> }
  | { type: "sqlite"; tables: { name: string; count: number }[] }
  | { type: "rows"; table: string; page: number; columns: string[]; rows: string[][] };
