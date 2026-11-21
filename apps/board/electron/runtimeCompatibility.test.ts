import { describe, expect, it } from "vite-plus/test";

import { runtimeSupportsClient } from "./runtimeCompatibility";

describe("runtime compatibility", () => {
  it.each([
    ["t3 v0.0.30", false],
    ["t3 v0.1.0", true],
    ["t3 v0.1.10", true],
    ["0.2.0-nightly.20261201.1", true],
  ])("Given runtime output %s, when checked, then compatible is %s", (output, compatible) => {
    expect(runtimeSupportsClient(output)).toBe(compatible);
  });
});
