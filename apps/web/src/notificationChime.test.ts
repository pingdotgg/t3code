import { DEFAULT_NOTIFICATION_VOLUME } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { chimeGainForVolume } from "./notificationChime";

describe("chimeGainForVolume", () => {
  it("leaves real headroom above the default", () => {
    expect(chimeGainForVolume(100)).toBeGreaterThan(
      chimeGainForVolume(DEFAULT_NOTIFICATION_VOLUME) * 4,
    );
  });

  it("increases monotonically across the supported range", () => {
    for (let volume = 20; volume <= 100; volume += 10) {
      expect(chimeGainForVolume(volume)).toBeGreaterThan(chimeGainForVolume(volume - 10));
    }
  });

  it("clamps out-of-range inputs", () => {
    expect(chimeGainForVolume(-100)).toBe(chimeGainForVolume(0));
    expect(chimeGainForVolume(200)).toBe(chimeGainForVolume(100));
  });
});
