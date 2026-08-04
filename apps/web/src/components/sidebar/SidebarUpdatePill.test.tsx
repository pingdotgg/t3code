import { describe, expect, it } from "vite-plus/test";

import { NIGHTLY_RELEASE_NOTES_TOOLTIP_CLASS_NAME } from "./SidebarUpdatePill";

describe("nightly release notes tooltip", () => {
  it("keeps the whole popup hoverable while moving from the update pill", () => {
    expect(NIGHTLY_RELEASE_NOTES_TOOLTIP_CLASS_NAME).toContain("pointer-events-auto");
  });
});
