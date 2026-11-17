// No GT import: preview workers load this, and their errors cross `postMessage` as a code.
// `zipErrorMessages.ts` holds the translatable text for each code.
const ENGLISH = {
  "file-too-large": "Preview limited to files under 50 MB.",
  "archive-too-many-entries": "This archive contains more than 2,048 entries.",
  "archive-path-too-long": "An archive path is too long to preview.",
  "archive-expanded-too-large":
    "The expanded archive exceeds the preview size or compression ratio limit.",
  "zip-unreadable": "This is not a readable ZIP archive.",
  "zip64-unsupported": "Unsupported ZIP64 directory.",
  "zip64-damaged": "This ZIP64 directory is too large or damaged.",
  "zip-directory-damaged": "This ZIP directory is damaged.",
} as const;

export type ZipErrorCode = keyof typeof ENGLISH;

/** A ZIP the preview limits reject; `message` stays English for logs. */
export class ZipError extends Error {
  readonly code: ZipErrorCode;

  constructor(code: ZipErrorCode) {
    super(ENGLISH[code]);
    this.code = code;
  }
}

export function isZipError(error: unknown): error is ZipError {
  return error instanceof ZipError;
}
