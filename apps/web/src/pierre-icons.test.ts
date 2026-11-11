import { assert, describe, it } from "vite-plus/test";

import {
  hasSpecificPierreIconForFileName,
  resolvePierreIconForEntry,
  syntheticFileNameForLanguageId,
  T3_PIERRE_ICONS,
} from "./pierre-icons";

describe("Pierre file icons", () => {
  it.each(["photo.heic", "photo.heif", "PHOTO.HEIC", "folder/photo.HEIF"])(
    "uses the image icon for %s",
    (name) => {
      assert.equal(resolvePierreIconForEntry(name, "file")?.token, "image");
      assert.isTrue(hasSpecificPierreIconForFileName(name));
    },
  );
  it("uses detected types for extensionless files while keeping known filename icons", () => {
    assert.equal(
      resolvePierreIconForEntry("custom-script", "file", "text/x-python")?.token,
      "python",
    );
    assert.equal(resolvePierreIconForEntry("image", "file", "image/png")?.token, "image");
    assert.equal(
      resolvePierreIconForEntry("Dockerfile", "file", "text/x-shellscript")?.token,
      "docker",
    );
    assert.isNull(resolvePierreIconForEntry("folder.png", "directory", "image/png"));
    assert.equal(
      resolvePierreIconForEntry("unknown", "file", "application/octet-stream")?.token,
      "default",
    );
  });

  it.each([
    ["pdf", "pdf"],
    ["doc", "word"],
    ["docx", "word"],
    ["odt", "word"],
    ["rtf", "word"],
    ["xls", "spreadsheet"],
    ["xlsx", "spreadsheet"],
    ["ods", "spreadsheet"],
    ["csv", "spreadsheet"],
    ["tsv", "spreadsheet"],
    ["ppt", "slides"],
    ["pptx", "slides"],
    ["odp", "slides"],
    ["epub", "epub"],
  ])("uses the document family icon for %s", (extension, family) => {
    for (const path of [`report.${extension}`, `folder/REPORT.${extension.toUpperCase()}`]) {
      assert.equal(resolvePierreIconForEntry(path, "file")?.name, `t3-file-icon-${family}`);
      assert.isTrue(hasSpecificPierreIconForFileName(path));
    }
  });

  it("ships every custom icon referenced by the extended resolver", () => {
    const customIconNames = new Set(
      [
        ...Object.values(T3_PIERRE_ICONS.byFileName),
        ...Object.values(T3_PIERRE_ICONS.byFileExtension),
      ].filter((name) => name.startsWith("t3-")),
    );
    for (const iconName of customIconNames) {
      assert.include(T3_PIERRE_ICONS.spriteSheet, `id="${iconName}"`);
    }
  });

  it.each([
    ["luau", "lua"],
    ["xsd", "xml"],
    ["xsl", "xml"],
    ["xslt", "xml"],
  ])("gives %s files and fences the %s icon", (dialect, base) => {
    const baseIcon = resolvePierreIconForEntry(`file.${base}`, "file")?.name;
    assert.equal(baseIcon, `t3-file-icon-${base}`);
    for (const path of [`src/init.${dialect}`, `src/INIT.${dialect.toUpperCase()}`]) {
      assert.equal(resolvePierreIconForEntry(path, "file")?.name, baseIcon);
      assert.isTrue(hasSpecificPierreIconForFileName(path));
    }
    assert.equal(
      resolvePierreIconForEntry(syntheticFileNameForLanguageId(dialect), "file")?.name,
      baseIcon,
    );
  });
});
