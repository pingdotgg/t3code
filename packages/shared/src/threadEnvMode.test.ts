import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultThreadEnvMode, surfaceDefaultThreadEnvMode } from "./threadEnvMode.ts";

describe("surfaceDefaultThreadEnvMode", () => {
  it("uses the current checkout when the user's attention is attached to it", () => {
    expect(surfaceDefaultThreadEnvMode("attached-checkout")).toBe("local");
  });

  it("isolates in a worktree on detached surfaces", () => {
    expect(surfaceDefaultThreadEnvMode("detached")).toBe("worktree");
  });
});

describe("resolveDefaultThreadEnvMode", () => {
  it("derives from the surface when surface derivation is on", () => {
    expect(
      resolveDefaultThreadEnvMode({
        deriveFromSurface: true,
        configuredMode: "worktree",
        surface: "attached-checkout",
      }),
    ).toBe("local");
    expect(
      resolveDefaultThreadEnvMode({
        deriveFromSurface: true,
        configuredMode: "local",
        surface: "detached",
      }),
    ).toBe("worktree");
  });

  it("pins the configured mode on every surface when derivation is off", () => {
    expect(
      resolveDefaultThreadEnvMode({
        deriveFromSurface: false,
        configuredMode: "worktree",
        surface: "attached-checkout",
      }),
    ).toBe("worktree");
    expect(
      resolveDefaultThreadEnvMode({
        deriveFromSurface: false,
        configuredMode: "local",
        surface: "detached",
      }),
    ).toBe("local");
  });
});
