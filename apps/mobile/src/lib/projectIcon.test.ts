import { describe, expect, it } from "vite-plus/test";

import { resolveProjectIconGlyph } from "./projectIcon";

describe("resolveProjectIconGlyph", () => {
  it("draws the No project icon with its Lucide paths", () => {
    expect(
      resolveProjectIconGlyph(
        { kind: "lucide", name: "message-square-dashed", color: "gray" },
        "No project",
      ),
    ).toMatchObject({ kind: "lucide", color: "gray" });
  });

  it("falls back to the monogram for a Lucide icon mobile has no symbol for", () => {
    expect(
      resolveProjectIconGlyph({ kind: "lucide", name: "rocket", color: "blue" }, "Launch Pad"),
    ).toEqual({ kind: "monogram", text: "LP", color: "blue" });
  });
});
