import { assert, describe, it } from "vite-plus/test";

import {
  resolvePierreIconForEntry,
  syntheticFileNameForLanguageId,
  T3_PIERRE_ICONS,
} from "./pierre-icons";

describe("Pierre file icons", () => {
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
    ["xsl", "xml"],
  ])("gives %s files and fences the %s icon", (dialect, base) => {
    const baseIcon = resolvePierreIconForEntry(`file.${base}`, "file")?.name;
    assert.equal(resolvePierreIconForEntry(`src/init.${dialect}`, "file")?.name, baseIcon);
    assert.equal(
      resolvePierreIconForEntry(syntheticFileNameForLanguageId(dialect), "file")?.name,
      baseIcon,
    );
  });
});
