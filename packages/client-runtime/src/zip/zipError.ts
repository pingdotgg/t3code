import * as Schema from "effect/Schema";

// No GT import: preview workers load this, and their errors cross `postMessage` as a code.
// `zipErrorMessages.ts` holds the translatable text for each code.
const CODES = [
  "file-too-large",
  "archive-too-many-entries",
  "archive-path-too-long",
  "archive-expanded-too-large",
  "password-required",
  "password-incorrect",
  "encryption-unsupported",
  "zip-unreadable",
  "zip64-unsupported",
  "zip64-damaged",
  "zip-directory-damaged",
] as const;

export type ZipErrorCode = (typeof CODES)[number];

const ENGLISH: Record<ZipErrorCode, string> = {
  "file-too-large": "Preview limited to files under 50 MB.",
  "archive-too-many-entries": "This archive contains more than 2,048 entries.",
  "archive-path-too-long": "An archive path is too long to preview.",
  "archive-expanded-too-large":
    "The expanded archive exceeds the preview size or compression ratio limit.",
  "password-required": "This file requires a password.",
  "password-incorrect": "Incorrect password. Try again.",
  "encryption-unsupported": "This file uses encryption that the preview cannot open.",
  "zip-unreadable": "This is not a readable ZIP archive.",
  "zip64-unsupported": "Unsupported ZIP64 directory.",
  "zip64-damaged": "This ZIP64 directory is too large or damaged.",
  "zip-directory-damaged": "This ZIP directory is damaged.",
};

/** A ZIP the preview limits reject; `message` stays English for logs. */
export class ZipError extends Schema.TaggedError<ZipError>()("ZipError", {
  code: Schema.Literals(CODES),
}) {
  override get message(): string {
    return ENGLISH[this.code];
  }
}

export const isZipError = Schema.is(ZipError);
