import { describe, expect, it } from "vite-plus/test";

describe("contextChipPresentation", () => {
  it("draws a mentioned machine as a machine, not the generic file chip", async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    expect(contextChipPresentation("environment")).toEqual({
      accent: "#3f9a4f",
      icon: "server",
    });
  });
});
