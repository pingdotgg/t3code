import { describe, expect, it } from "vite-plus/test";

import { TAILCAT_BACKOFF_MAX_MS, tailcatBackoffBaseMs, tailcatBackoffDelayMs } from "./backoff.ts";

describe("tailcat backoff", () => {
  it("grows with each failure and caps", () => {
    expect(tailcatBackoffBaseMs(0)).toBe(0);
    expect(tailcatBackoffBaseMs(1)).toBe(1_000);
    expect(tailcatBackoffBaseMs(3)).toBe(5_000);
    expect(tailcatBackoffBaseMs(6)).toBe(TAILCAT_BACKOFF_MAX_MS);
    expect(tailcatBackoffBaseMs(40)).toBe(TAILCAT_BACKOFF_MAX_MS);
  });

  it("jitters symmetrically within a quarter of the base", () => {
    expect(tailcatBackoffDelayMs(2, 0)).toBe(1_500);
    expect(tailcatBackoffDelayMs(2, 0.5)).toBe(2_000);
    expect(tailcatBackoffDelayMs(2, 1)).toBe(2_500);
    expect(tailcatBackoffDelayMs(0, 0.9)).toBe(0);
  });
});
