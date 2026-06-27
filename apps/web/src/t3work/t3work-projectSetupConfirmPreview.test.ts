import { describe, expect, it } from "vite-plus/test";

import { buildT3workProjectSetupConfirmPreview } from "./t3work-projectSetupConfirmPreview";

describe("buildT3workProjectSetupConfirmPreview", () => {
  it("surfaces enabled skill packs and ranked starter recipes for a bundled profile", () => {
    const preview = buildT3workProjectSetupConfirmPreview({ profileId: "engineering-copilot" });

    expect(preview.profile.id).toBe("engineering-copilot");
    expect(preview.enabledSkillPackIds).toContain("engineering");
    expect(preview.skillPacks.map((pack) => pack.id)).toContain("engineering");
    expect(preview.topRecipes.length).toBeGreaterThan(0);
    expect(preview.topRecipes[0]?.title.length).toBeGreaterThan(0);
  });
});
