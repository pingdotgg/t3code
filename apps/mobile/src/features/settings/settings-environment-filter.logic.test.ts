import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { toggleSettingsEnvironment } from "./settings-environment-filter.logic";

describe("settings environment selection", () => {
  it("keeps a selected offline environment when toggling another connected environment", () => {
    const a = EnvironmentId.make("a");
    const b = EnvironmentId.make("b");
    const c = EnvironmentId.make("c");
    const d = EnvironmentId.make("d");
    const all = [a, b, c, d].map((environmentId) => ({ environmentId }));
    const withoutC = toggleSettingsEnvironment(null, all, c);
    const selected = toggleSettingsEnvironment(withoutC, all, d);
    expect(selected).toEqual(new Set([a, b]));

    const connected = all.filter((entry) => entry.environmentId !== b);
    const next = toggleSettingsEnvironment(selected, connected, c);
    const reconnectedTargets = all.filter(
      (entry) => next === null || next.has(entry.environmentId),
    );
    expect(reconnectedTargets.map((entry) => entry.environmentId)).toEqual([a, b, c]);
  });
});
