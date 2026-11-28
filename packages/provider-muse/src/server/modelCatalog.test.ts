import { describe, expect, it } from "@effect/vitest";

import {
  museModelCapabilities,
  resolveMuseProbeTimeoutMs,
  resolveMuseReasoningEffort,
  resolveMuseStartupTimeoutMs,
} from "./modelCatalog.ts";

describe("Muse model catalog", () => {
  it("normalizes saved and implicit efforts against the selected model before dispatch", () => {
    const fallback = museModelCapabilities();
    expect(resolveMuseReasoningEffort(fallback, undefined)).toBe("high");
    expect(resolveMuseReasoningEffort(fallback, "max")).toBe("max");
    expect(resolveMuseReasoningEffort(fallback, "ultra")).toBe("high");
    const restricted = museModelCapabilities({ variants: ["xhigh"] });
    expect(resolveMuseReasoningEffort(restricted, undefined)).toBe("xhigh");
    expect(resolveMuseReasoningEffort(restricted, "low")).toBe("xhigh");
    expect(
      resolveMuseReasoningEffort(museModelCapabilities({ variants: [] }), "max"),
    ).toBeUndefined();
    expect(resolveMuseReasoningEffort(undefined, "max")).toBe("max");
  });

  it("gives the Windows launcher chain extra time without changing other platforms", () => {
    expect(resolveMuseStartupTimeoutMs("linux", {})).toBe(8_000);
    expect(resolveMuseStartupTimeoutMs("win32", {})).toBe(20_000);
    expect(resolveMuseProbeTimeoutMs(4_000, "linux", {})).toBe(4_000);
    expect(resolveMuseProbeTimeoutMs(4_000, "win32", {})).toBe(16_000);
    const override = { T3CODE_MUSE_PROBE_TIMEOUT_MS: "10000" };
    expect(resolveMuseStartupTimeoutMs("linux", override)).toBe(10_000);
    expect(resolveMuseStartupTimeoutMs("win32", override)).toBe(20_000);
  });
});
