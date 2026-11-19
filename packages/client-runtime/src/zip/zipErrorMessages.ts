import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { ZipErrorCode } from "./zipError.ts";

/** Translatable text for each `ZipError` code. Keep it out of worker imports. */
export const ZIP_ERROR_MESSAGES: Record<ZipErrorCode, string> = {
  "file-too-large": msg("Preview limited to files under 50 MB."),
  "archive-too-many-entries": msg("This archive contains more than 2,048 entries."),
  "archive-path-too-long": msg("An archive path is too long to preview."),
  "archive-expanded-too-large": msg(
    "The expanded archive exceeds the preview size or compression ratio limit.",
  ),
  "zip-unreadable": msg("This is not a readable ZIP archive."),
  "zip64-unsupported": msg("Unsupported ZIP64 directory."),
  "zip64-damaged": msg("This ZIP64 directory is too large or damaged."),
  "zip-directory-damaged": msg("This ZIP directory is damaged."),
};

export function zipErrorText(code: ZipErrorCode, resolve: MFunctionType = mFallback): string {
  return resolve(ZIP_ERROR_MESSAGES[code]);
}
