import { describe, expect, it } from "vite-plus/test";

import { deriveAvailableInstanceId } from "./providerInstanceIds.ts";

describe("deriveAvailableInstanceId", () => {
  it("derives a collision-free instance id without exceeding the slug limit", () => {
    const derive = (label: string) => `acpRegistry_${label}`;
    const existing = new Set(["acpRegistry_gemini", "acpRegistry_gemini_2"]);

    expect(deriveAvailableInstanceId(derive, "gemini", existing)).toBe("acpRegistry_gemini_3");

    const longBase = `acpRegistry_${"a".repeat(48)}`;
    expect(deriveAvailableInstanceId(() => longBase, "ignored", new Set([longBase]))).toHaveLength(
      62,
    );
  });
});
