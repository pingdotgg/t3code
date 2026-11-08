import { describe, expect, it } from "vite-plus/test";

import { resolveOpenInOptions } from "./OpenInPicker";

const available = ["idea", "ghostty", "file-manager"] as const;

describe("OpenInPicker options", () => {
  it("shows Ghostty alongside IntelliJ and Finder for projects", () => {
    expect(
      resolveOpenInOptions("MacIntel", available, "project").map(({ label }) => label),
    ).toEqual(["Ghostty", "IntelliJ IDEA", "Finder"]);
  });

  it("shows IntelliJ and Finder for files but hides Ghostty", () => {
    expect(resolveOpenInOptions("MacIntel", available, "file").map(({ label }) => label)).toEqual([
      "IntelliJ IDEA",
      "Finder",
    ]);
  });
});
