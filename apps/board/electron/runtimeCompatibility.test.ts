import { describe, expect, it } from "vite-plus/test";

import { runtimeSupportsClient } from "./runtimeCompatibility";

describe("runtime compatibility", () => {
  it("Given the 0.0.30 runtime T3 desktop stages, when checked, then it is incompatible", () => {
    expect(runtimeSupportsClient("t3 v0.0.30")).toBe(false);
  });

  it("Given 0.1.0 and later releases, when checked, then they are compatible", () => {
    expect(runtimeSupportsClient("t3 v0.1.0")).toBe(true);
    expect(runtimeSupportsClient("t3 v0.1.10")).toBe(true);
    expect(runtimeSupportsClient("0.2.0-nightly.20261201.1")).toBe(true);
  });

  it("Given output with no version, when checked, then it is incompatible", () => {
    expect(runtimeSupportsClient("")).toBe(false);
  });
});
