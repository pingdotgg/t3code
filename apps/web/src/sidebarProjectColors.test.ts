import { describe, expect, it } from "vitest";
import type { SidebarProjectColor } from "@t3tools/contracts/settings";
import {
  autoSidebarProjectColor,
  buildSidebarProjectColorMap,
  resolveSidebarProjectColor,
  SIDEBAR_PROJECT_COLOR_PALETTE,
} from "./sidebarProjectColors";

describe("sidebarProjectColors", () => {
  it("returns a palette entry for any seed", () => {
    const result = autoSidebarProjectColor("environment-local:/tmp/example");
    expect(SIDEBAR_PROJECT_COLOR_PALETTE).toContain(result);
  });

  it("is deterministic for the same seed", () => {
    const seed = "environment-local:/tmp/example";
    expect(autoSidebarProjectColor(seed).key).toBe(autoSidebarProjectColor(seed).key);
  });

  it("spreads similar seeds across multiple palette entries", () => {
    const seeds = Array.from({ length: 24 }, (_, index) => `env:/tmp/project-${index}`);
    const usedKeys = new Set(seeds.map((seed) => autoSidebarProjectColor(seed).key));
    // Not strictly guaranteed by the palette length, but the FNV-1a spread
    // should easily hit at least half the palette across 24 distinct seeds.
    expect(usedKeys.size).toBeGreaterThanOrEqual(SIDEBAR_PROJECT_COLOR_PALETTE.length / 2);
  });

  it("prefers the explicit override over the auto color", () => {
    const seed = "environment-local:/tmp/example";
    const auto = autoSidebarProjectColor(seed);
    // Pick an override that doesn't match the auto choice for the seed.
    const override =
      SIDEBAR_PROJECT_COLOR_PALETTE.find((entry) => entry.key !== auto.key)?.key ?? "rose";
    expect(resolveSidebarProjectColor(seed, override).key).toBe(override);
  });

  it("falls back to the auto color when override is undefined", () => {
    const seed = "environment-local:/tmp/example";
    expect(resolveSidebarProjectColor(seed, undefined).key).toBe(autoSidebarProjectColor(seed).key);
  });
});

describe("buildSidebarProjectColorMap", () => {
  it("returns an empty map when no projects are passed", () => {
    expect(buildSidebarProjectColorMap({ projects: [], overrides: {} }).size).toBe(0);
  });

  it("gives each project a distinct auto color when the palette has room", () => {
    const projects = SIDEBAR_PROJECT_COLOR_PALETTE.map((_, index) => ({
      projectKey: `key-${index}`,
      overrideKey: `override-${index}`,
    }));
    const map = buildSidebarProjectColorMap({ projects, overrides: {} });
    const keys = Array.from(map.values()).map((identity) => identity.palette.key);
    expect(new Set(keys).size).toBe(SIDEBAR_PROJECT_COLOR_PALETTE.length);
  });

  it("walks past colors already claimed by overrides", () => {
    // Find an override-key whose hash lands on the same palette entry as the
    // override below — that's the case where naive resolution would collide.
    const targetColor: SidebarProjectColor = "rose";
    const collidingSeed = (() => {
      for (let i = 0; i < 1000; i++) {
        const seed = `seed-${i}`;
        if (autoSidebarProjectColor(seed).key === targetColor) {
          return seed;
        }
      }
      throw new Error("Failed to find a colliding seed for the test fixture");
    })();

    const map = buildSidebarProjectColorMap({
      projects: [
        { projectKey: "with-override", overrideKey: "override-key" },
        { projectKey: "auto", overrideKey: collidingSeed },
      ],
      overrides: {
        "override-key": targetColor,
      },
    });

    expect(map.get("with-override")?.palette.key).toBe(targetColor);
    expect(map.get("auto")?.palette.key).not.toBe(targetColor);
  });

  it("gives 11 projects 10 distinct colors plus one unavoidable repeat", () => {
    const projects = Array.from({ length: SIDEBAR_PROJECT_COLOR_PALETTE.length + 1 }, (_, i) => ({
      projectKey: `key-${i}`,
      overrideKey: `override-${i}`,
    }));
    const map = buildSidebarProjectColorMap({ projects, overrides: {} });
    const keys = Array.from(map.values()).map((identity) => identity.palette.key);
    expect(keys).toHaveLength(SIDEBAR_PROJECT_COLOR_PALETTE.length + 1);
    expect(new Set(keys).size).toBe(SIDEBAR_PROJECT_COLOR_PALETTE.length);
  });

  it("preserves an existing project's color when a later-sorted project is added", () => {
    const before = buildSidebarProjectColorMap({
      projects: [{ projectKey: "alpha", overrideKey: "aaa" }],
      overrides: {},
    });
    const after = buildSidebarProjectColorMap({
      projects: [
        { projectKey: "alpha", overrideKey: "aaa" },
        { projectKey: "beta", overrideKey: "zzz" },
      ],
      overrides: {},
    });
    // The earlier-sorted overrideKey ("aaa") gets first pick in both runs, so
    // its color must not change when "zzz" is added.
    expect(after.get("alpha")?.palette.key).toBe(before.get("alpha")?.palette.key);
  });

  it("processes auto-colors in overrideKey order regardless of input order", () => {
    const aRun = buildSidebarProjectColorMap({
      projects: [
        { projectKey: "a", overrideKey: "aaa" },
        { projectKey: "b", overrideKey: "zzz" },
      ],
      overrides: {},
    });
    const bRun = buildSidebarProjectColorMap({
      projects: [
        { projectKey: "b", overrideKey: "zzz" },
        { projectKey: "a", overrideKey: "aaa" },
      ],
      overrides: {},
    });
    expect(aRun.get("a")?.palette.key).toBe(bRun.get("a")?.palette.key);
    expect(aRun.get("b")?.palette.key).toBe(bRun.get("b")?.palette.key);
  });

  it("records the explicit override on the identity entry", () => {
    const map = buildSidebarProjectColorMap({
      projects: [{ projectKey: "p", overrideKey: "k" }],
      overrides: { k: "indigo" },
    });
    const identity = map.get("p");
    expect(identity?.override).toBe("indigo");
    expect(identity?.palette.key).toBe("indigo");
  });

  it("leaves auto entries with undefined override", () => {
    const map = buildSidebarProjectColorMap({
      projects: [{ projectKey: "p", overrideKey: "k" }],
      overrides: {},
    });
    expect(map.get("p")?.override).toBeUndefined();
  });
});
