import type { PreviewPassword, PreviewUnlock } from "./previewUnlock";
import type { PreviewFailure } from "./previewFailure";
import { ARCHIVE_MAX_BYTES } from "@t3tools/client-runtime/zip/bounded-zip";

export {
  ARCHIVE_ENTRY_MAX_BYTES,
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_RATIO,
} from "@t3tools/client-runtime/zip/bounded-zip";
export const BINARY_PREVIEW_MAX_BYTES = ARCHIVE_MAX_BYTES;
export const SQLITE_PAGE_SIZE = 50;

export function formatArchiveModifiedDate(
  modified: string | null,
  locales?: Intl.LocalesArgument,
): string {
  if (!modified) return "-";
  // ZIP times are zone-less wall-clock (no "Z"); formatting them in UTC keeps their calendar
  // date even when the viewer's zone skips that hour for daylight saving time.
  const wallClock = !modified.endsWith("Z");
  const date = new Date(wallClock ? `${modified}Z` : modified);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString(locales, wallClock ? { timeZone: "UTC" } : undefined);
}

export interface ArchiveEntry {
  path: string;
  size: number;
  modified: string | null;
  directory: boolean;
}

type ArchiveRowOrder = Pick<ArchiveEntry, "path" | "directory">;
let archiveNameCollator: Intl.Collator | undefined;

export function compareArchiveRows(a: ArchiveRowOrder, b: ArchiveRowOrder): number {
  if (a.directory !== b.directory) return a.directory ? -1 : 1;
  archiveNameCollator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return archiveNameCollator.compare(a.path, b.path);
}

export type BinaryWorkerRequest =
  | PreviewUnlock
  | { type: "open"; kind: "archive" | "sqlite"; name: string; bytes: ArrayBuffer }
  | { type: "entry"; path: string }
  | { type: "rows"; table: string; page: number };

export type BinaryWorkerResult =
  | PreviewPassword
  | ({ type: "error" } & PreviewFailure)
  | { type: "archive"; entries: ArchiveEntry[] }
  | { type: "entry"; path: string; bytes: Uint8Array<ArrayBuffer> }
  | { type: "sqlite"; tables: { name: string; count: number }[] }
  | { type: "rows"; table: string; page: number; columns: string[]; rows: string[][] };
