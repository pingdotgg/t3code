import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  backdropOpacity,
  DEFAULT_BACKDROP_SETTINGS,
  defaultBackdropSettings,
  KaluwaBackdropSettingsSchema,
  uploadArtId,
  withAvailableArt,
} from "./backdropSettings";

const decode = Schema.decodeUnknownSync(KaluwaBackdropSettingsSchema);

describe("backdrop settings", () => {
  it("turns the art off by default and keeps today's wave band", () => {
    expect(DEFAULT_BACKDROP_SETTINGS.art).toBe("none");
    expect(DEFAULT_BACKDROP_SETTINGS.band).toBe("wave");
  });

  it("starts Kaluwa on the Ember preset", () => {
    expect(defaultBackdropSettings(true)).toMatchObject({
      art: "horse",
      pattern: "scatter",
      shape: "square",
      cell: 4,
      density: 58,
      opacity: 88,
      fade: 75,
      inThreads: 30,
      placement: "full",
      colorMode: "accent",
    });
    expect(defaultBackdropSettings(false).art).toBe("none");
  });

  it("fills fields an older save does not have", () => {
    const decoded = decode({ art: "lotus", image: { mode: "photo" } });
    expect(decoded.art).toBe("lotus");
    expect(decoded.cell).toBe(4);
    expect(decoded.image.mode).toBe("photo");
    expect(decoded.image.dither).toBe("atkinson");
  });

  it("rejects values outside their range", () => {
    expect(() => decode({ cell: 40 })).toThrow();
    expect(() => decode({ placement: "left" })).toThrow();
  });
});

describe("backdropOpacity", () => {
  const settings = { ...DEFAULT_BACKDROP_SETTINGS, art: "horse", opacity: 80, inThreads: 30 };

  it("is full strength at home and dimmer in threads", () => {
    expect(backdropOpacity(settings, "home")).toBeCloseTo(0.8);
    expect(backdropOpacity(settings, "thread")).toBeCloseTo(0.24);
  });

  it("hides home-only art in threads, and hides when off", () => {
    expect(backdropOpacity({ ...settings, placement: "home" }, "thread")).toBe(0);
    expect(backdropOpacity({ ...settings, placement: "home" }, "home")).toBeCloseTo(0.8);
    expect(backdropOpacity({ ...settings, art: "none" }, "home")).toBe(0);
  });
});

describe("withAvailableArt", () => {
  it("turns the backdrop off when its uploaded image is gone", () => {
    const settings = { ...DEFAULT_BACKDROP_SETTINGS, art: uploadArtId("a") };
    expect(withAvailableArt(settings, new Set(["a"])).art).toBe(uploadArtId("a"));
    expect(withAvailableArt(settings, new Set()).art).toBe("none");
    // Uploads still loading: keep the choice.
    expect(withAvailableArt(settings, null).art).toBe(uploadArtId("a"));
  });

  it("drops an unknown artwork id", () => {
    expect(withAvailableArt({ ...DEFAULT_BACKDROP_SETTINGS, art: "dragons" }, null).art).toBe(
      "none",
    );
  });
});
