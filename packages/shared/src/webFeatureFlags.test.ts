import { describe, expect, it } from "vitest";

import {
  DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE,
  appendWebFeatureFlagsToUrl,
  normalizeWebFeatureFlags,
  readWebFeatureFlagsFromUrl,
} from "./webFeatureFlags.ts";

describe("webFeatureFlags", () => {
  it("normalizes known feature flags and ignores unknown values", () => {
    expect(
      normalizeWebFeatureFlags([
        DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE,
        "unknown",
        ` ${DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE} `,
      ]),
    ).toEqual([DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE]);
  });

  it("reads repeated and comma-separated feature flags from urls", () => {
    const url = new URL(
      `https://example.com/pair?salchiFeature=unknown,${DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE}`,
    );

    expect(readWebFeatureFlagsFromUrl(url)).toEqual([DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE]);
  });

  it("appends feature flags without duplicating existing values", () => {
    expect(
      appendWebFeatureFlagsToUrl(
        `https://example.com/pair?salchiFeature=${DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE}#token=abc`,
        [DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE],
      ),
    ).toBe(
      `https://example.com/pair?salchiFeature=${DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE}#token=abc`,
    );

    expect(
      appendWebFeatureFlagsToUrl("https://example.com/pair#token=abc", [
        DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE,
      ]),
    ).toBe(
      `https://example.com/pair?salchiFeature=${DOWNLOADABLE_DIAGNOSTICS_WEB_FEATURE}#token=abc`,
    );
  });
});
