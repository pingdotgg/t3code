import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KALUWA_LOOK, parseKaluwaLook } from "./kaluwaLook";

describe("parseKaluwaLook", () => {
  it("defaults to the approved look", () => {
    expect(parseKaluwaLook(null)).toEqual({
      mood: "luminous",
      statusEmphasis: "soft",
      statusColors: "palette",
      badges: "tinted",
      tiles: "tinted",
      logos: "soft",
      lift: 50,
      statusSwatches: {},
    });
  });

  it("keeps valid fields and defaults the rest", () => {
    expect(
      parseKaluwaLook(JSON.stringify({ mood: "jewel", badges: "sparkly", lift: 120 })),
    ).toEqual({ ...DEFAULT_KALUWA_LOOK, mood: "jewel", lift: 100 });
  });

  it("survives malformed storage", () => {
    expect(parseKaluwaLook("{not json")).toEqual(DEFAULT_KALUWA_LOOK);
    expect(parseKaluwaLook("[1,2]")).toEqual(DEFAULT_KALUWA_LOOK);
    expect(parseKaluwaLook(JSON.stringify({ lift: "high" })).lift).toBe(50);
  });

  it("keeps status picks that name a swatch or a hex colour", () => {
    expect(
      parseKaluwaLook(
        JSON.stringify({
          statusSwatches: { working: "lagoon", failed: "#AA3311", done: "neon", nope: "clay" },
        }),
      ).statusSwatches,
    ).toEqual({ working: "lagoon", failed: "#aa3311" });
  });
});
