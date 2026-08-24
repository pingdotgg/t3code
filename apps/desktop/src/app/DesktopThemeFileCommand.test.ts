import { assert, describe, it } from "@effect/vitest";

import { themeFilePathFromArguments } from "./DesktopThemeFileCommand.ts";

describe("DesktopThemeFileCommand", () => {
  it("reads a separated theme file argument", () => {
    assert.equal(
      themeFilePathFromArguments(["t3code", "--theme-file", "/tmp/omarchy theme.json"]),
      "/tmp/omarchy theme.json",
    );
  });

  it("reads an inline theme file argument", () => {
    assert.equal(
      themeFilePathFromArguments(["t3code", "--theme-file=/tmp/theme.json"]),
      "/tmp/theme.json",
    );
  });

  it("ignores missing and empty values", () => {
    assert.isNull(themeFilePathFromArguments(["t3code", "--theme-file"]));
    assert.isNull(themeFilePathFromArguments(["t3code", "--theme-file="]));
    assert.isNull(themeFilePathFromArguments(["t3code", "--theme-file", "--inspect"]));
  });
});
