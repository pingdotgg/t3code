import { describe, expect, it } from "@effect/vitest";

import { fileReferenceClipboardPayload, sanitizeClipboardFileName } from "./fileClipboard.ts";

describe("sanitizeClipboardFileName", () => {
  it("strips path separators and NUL bytes", () => {
    expect(sanitizeClipboardFileName("../secrets/key.pem")).toBe(".._secrets_key.pem");
    expect(sanitizeClipboardFileName("a\\b:c\0d.csv")).toBe("a_b_c_d.csv");
  });

  it("falls back for names that reduce to nothing", () => {
    expect(sanitizeClipboardFileName("..")).toBe("download");
  });
});

describe("fileReferenceClipboardPayload", () => {
  it("emits an escaped NSFilenamesPboardType plist on macOS", () => {
    const payload = fileReferenceClipboardPayload("darwin", "/tmp/a & b.csv");
    expect(payload.format).toBe("NSFilenamesPboardType");
    const plist = payload.buffer.toString("utf8");
    expect(plist).toContain("<string>/tmp/a &amp; b.csv</string>");
    expect(plist).toContain('<plist version="1.0">');
  });

  it("emits a wide-character DROPFILES struct on Windows", () => {
    const payload = fileReferenceClipboardPayload("win32", String.raw`C:\tmp\a.csv`);
    expect(payload.format).toBe("CF_HDROP");
    expect(payload.buffer.readUInt32LE(0)).toBe(20);
    expect(payload.buffer.readUInt32LE(16)).toBe(1);
    expect(payload.buffer.subarray(20).toString("utf16le")).toBe("C:\\tmp\\a.csv\0\0");
  });

  it("emits the GNOME copied-files convention on Linux", () => {
    const payload = fileReferenceClipboardPayload("linux", "/tmp/relatório final.csv");
    expect(payload.format).toBe("x-special/gnome-copied-files");
    expect(payload.buffer.toString("utf8")).toBe("copy\nfile:///tmp/relat%C3%B3rio%20final.csv");
  });
});
