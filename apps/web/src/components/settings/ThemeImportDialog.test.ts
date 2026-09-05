import { describe, expect, it } from "vite-plus/test";

import {
  describeOversizedThemeFile,
  describeOversizedThemePackage,
  isThemePackageName,
  MAX_THEME_FILE_BYTES,
} from "./ThemeImportDialog";
import { MAX_VSIX_BYTES } from "../../vsixThemePackage";

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
});

describe("theme package size guard", () => {
  it("accepts a package up to the VSIX limit", () => {
    for (const bytes of [0, MAX_THEME_FILE_BYTES + 1, MAX_VSIX_BYTES]) {
      expect(describeOversizedThemePackage(bytes)).toBeNull();
    }
  });

  it("rejects a package past the VSIX limit and names both sizes", () => {
    const message = describeOversizedThemePackage(64 * 1024 * 1024);
    expect(message).toContain("64.0 MB");
    expect(message).toContain("20.0 MB");
  });
});

describe("theme package detection", () => {
  it("recognizes .vsix regardless of case", () => {
    expect(isThemePackageName("dracula-pro.vsix")).toBe(true);
    expect(isThemePackageName("Dracula-Pro.VSIX")).toBe(true);
  });

  it("leaves theme JSON to the file importer", () => {
    expect(isThemePackageName("dracula.json")).toBe(false);
    expect(isThemePackageName("vsix")).toBe(false);
  });
});
