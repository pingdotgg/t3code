import { describe, expect, it } from "@effect/vitest";

import {
  agentSettingsContextKey,
  parseRequiredNumber,
  resolveAgentSettingsEnvironmentId,
} from "./agentSettings.logic";

describe("mobile agent settings numeric fields", () => {
  it("trims input before parsing it once", () => {
    expect(parseRequiredNumber("  12.5  ", "Limit")).toBe(12.5);
  });

  it("rejects blank and non-finite values", () => {
    expect(() => parseRequiredNumber("   ", "Limit")).toThrow("Limit is required.");
    expect(() => parseRequiredNumber("NaN", "Limit")).toThrow("Limit must be a finite number.");
    expect(() => parseRequiredNumber("Infinity", "Limit")).toThrow(
      "Limit must be a finite number.",
    );
    expect(() => parseRequiredNumber("-Infinity", "Limit")).toThrow(
      "Limit must be a finite number.",
    );
  });

  it("changes when a local editor generation changes", () => {
    const context = { environmentId: "env", projectId: null, selectionKey: null };
    expect(agentSettingsContextKey({ ...context, generation: 1 })).not.toBe(
      agentSettingsContextKey({ ...context, generation: 2 }),
    );
  });

  it("pins the implicit environment when connection ordering changes", () => {
    const initial = resolveAgentSettingsEnvironmentId(null, ["alpha", "beta"]);
    expect(initial).toBe("alpha");
    expect(resolveAgentSettingsEnvironmentId(initial, ["beta", "alpha"])).toBe("alpha");
  });

  it("moves to the next environment only when the pinned one disappears", () => {
    expect(resolveAgentSettingsEnvironmentId("alpha", ["beta"])).toBe("beta");
    expect(resolveAgentSettingsEnvironmentId("alpha", [])).toBeNull();
  });
});
