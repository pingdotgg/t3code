import { describe, expect, it } from "vite-plus/test";

import { composerCommandEmptyText } from "./composerCommandPopoverText";

describe("composerCommandEmptyText", () => {
  it("uses legible loading copy for path and command searches", () => {
    expect(composerCommandEmptyText("path", true)).toBe("Searching files…");
    expect(composerCommandEmptyText("slash-command", true)).toBe("Loading…");
  });

  it("uses trigger-specific empty copy", () => {
    expect(composerCommandEmptyText("path", false)).toBe("No matching files or folders.");
    expect(composerCommandEmptyText("skill", false)).toBe("No skills found.");
    expect(composerCommandEmptyText("slash-command", false)).toBe("No matching commands.");
    expect(composerCommandEmptyText(null, false)).toBe("No results.");
  });
});
