import { describe, expect, it } from "vite-plus/test";

import {
  describeOversizedThemeBatch,
  describeOversizedThemeFile,
  MAX_THEME_BATCH_BYTES,
  MAX_THEME_BATCH_FILES,
  MAX_THEME_FILE_BYTES,
} from "./ThemeImportDialog";

describe("theme import size guard", () => {
  it("accepts anything a theme file could plausibly be", () => {
    for (const bytes of [0, 4_096, MAX_THEME_FILE_BYTES]) {
      expect(describeOversizedThemeFile(bytes)).toBeNull();
    }
  });

  it("rejects a file too large to be a theme and names its size", () => {
    const message = describeOversizedThemeFile(100 * 1024 * 1024);
    expect(message).toContain("100.0 MB");
    expect(message).toContain("256 KB");
  });

  it("reports sizes just past the limit in KB", () => {
    expect(describeOversizedThemeFile(MAX_THEME_FILE_BYTES + 1)).toContain("256 KB");
  });

  it("bounds batch count and aggregate bytes before reading files", () => {
    expect(
      describeOversizedThemeBatch(
        Array.from({ length: MAX_THEME_BATCH_FILES + 1 }, () => ({ size: 1 })),
      ),
    ).toContain(String(MAX_THEME_BATCH_FILES));
    expect(describeOversizedThemeBatch([{ size: MAX_THEME_BATCH_BYTES + 1 }])).toContain("2.0 MB");
    expect(describeOversizedThemeBatch([{ size: MAX_THEME_BATCH_BYTES }])).toBeNull();
  });
});
