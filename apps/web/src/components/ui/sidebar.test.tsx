import { describe, expect, it } from "vitest";

import { SIDEBAR_INSET_BASE_CLASSNAME } from "./sidebar.logic";

describe("SidebarInset", () => {
  it("stays shrinkable inside flex layouts", () => {
    expect(SIDEBAR_INSET_BASE_CLASSNAME).toContain("min-w-0");
  });
});
