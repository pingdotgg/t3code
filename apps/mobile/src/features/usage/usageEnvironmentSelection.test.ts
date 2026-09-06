import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { toggleUsageEnvironment } from "./usageEnvironmentSelection";

const a = EnvironmentId.make("a");
const b = EnvironmentId.make("b");
const c = EnvironmentId.make("c");
const removed = EnvironmentId.make("removed");
const environments = [a, b, c].map((environmentId) => ({ environmentId }));

describe("usage environment selection", () => {
  it("can exclude an environment from all, then select all again", () => {
    const selected = toggleUsageEnvironment(null, environments, b);
    expect(selected).toEqual(new Set([a, c]));
    expect(toggleUsageEnvironment(selected, environments, b)).toBeNull();
  });

  it("can deselect the last environment", () => {
    expect(toggleUsageEnvironment(new Set([a]), environments, a)).toEqual(new Set());
  });

  it("does not count removed IDs toward selecting all current environments", () => {
    expect(toggleUsageEnvironment(new Set([a, removed]), environments, b)).toEqual(new Set([a, b]));
  });

  it("returns to all mode despite stale IDs when every current environment is selected", () => {
    expect(toggleUsageEnvironment(new Set([a, c, removed]), environments, b)).toBeNull();
  });

  it("ignores a menu action for an environment that was removed", () => {
    expect(toggleUsageEnvironment(new Set([a]), environments, removed)).toEqual(new Set([a]));
  });

  it("includes newly connected environments only in all mode", () => {
    const expanded = [...environments, { environmentId: removed }];
    expect(toggleUsageEnvironment(null, expanded, a)).toEqual(new Set([b, c, removed]));
    expect(toggleUsageEnvironment(new Set([a, b, c]), expanded, a)).toEqual(new Set([b, c]));
  });
});
