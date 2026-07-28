import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarStageBackdropVariant } from "./SidebarStageBackdrop";

describe("resolveSidebarStageBackdropVariant", () => {
  it.each([
    ["Alpha", "alpha"],
    ["Nightly", "nightly"],
    ["Dev", "dev"],
  ] as const)("maps the %s channel to its themed backdrop", (label, expected) => {
    expect(resolveSidebarStageBackdropVariant(label)).toBe(expected);
  });

  it("leaves stable and latest builds unthemed", () => {
    expect(resolveSidebarStageBackdropVariant("Latest")).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Stable")).toBeNull();
  });
});
