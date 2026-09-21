import { describe, expect, it } from "vite-plus/test";

import { resolveProjectFileDefault } from "./projectFileDefaults.ts";

describe("resolveProjectFileDefault", () => {
  it("prefers the setting over t3.json over the built-in default", () => {
    expect(
      resolveProjectFileDefault({
        setting: "none",
        projectFile: "top-level",
        builtIn: "recursive",
      }),
    ).toBe("none");
    expect(
      resolveProjectFileDefault({ setting: null, projectFile: "top-level", builtIn: "recursive" }),
    ).toBe("top-level");
    expect(
      resolveProjectFileDefault({ setting: undefined, projectFile: null, builtIn: "recursive" }),
    ).toBe("recursive");
  });
});
