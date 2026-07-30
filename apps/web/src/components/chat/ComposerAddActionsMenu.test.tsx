import { describe, expect, it } from "vite-plus/test";

import { resolveComposerAddActionModes } from "./ComposerAddActionsMenu";

describe("resolveComposerAddActionModes", () => {
  it("keeps the Forma Build, Ask, Plan order for Ask-capable providers", () => {
    expect(resolveComposerAddActionModes(["default", "ask", "plan"])).toEqual([
      "default",
      "ask",
      "plan",
    ]);
  });

  it("omits Ask when the provider does not advertise it", () => {
    expect(resolveComposerAddActionModes(["default", "plan"])).toEqual(["default", "plan"]);
  });
});
