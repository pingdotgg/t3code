import { describe, expect, it } from "vite-plus/test";

import { resolveThreadTitleRename } from "./thread-title-rename";

describe("resolveThreadTitleRename", () => {
  it("trims a changed title", () => {
    expect(resolveThreadTitleRename({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "rename",
      title: "New title",
    });
  });

  it("rejects empty and unchanged titles", () => {
    expect(resolveThreadTitleRename({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
    expect(resolveThreadTitleRename({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});
