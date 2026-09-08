import { describe, expect, test } from "alchemy-test";

import { _internal } from "../../src/Cli/checkVersion";

const { pickDistTag, compareVersions } = _internal;

describe("pickDistTag", () => {
  // Real shape returned by https://registry.npmjs.org/-/package/alchemy/dist-tags
  const realDistTags = { latest: "0.93.7", next: "2.0.0-beta.33" };

  test("beta version picks the matching prerelease tag (next) over latest", () => {
    expect(pickDistTag("2.0.0-beta.30", realDistTags)).toBe("2.0.0-beta.33");
  });

  test("stable version picks latest", () => {
    expect(pickDistTag("0.93.6", realDistTags)).toBe("0.93.7");
  });

  test("prefers identifier-named tag when present", () => {
    expect(
      pickDistTag("2.0.0-beta.30", {
        latest: "0.93.7",
        next: "2.0.0-rc.1",
        beta: "2.0.0-beta.40",
      }),
    ).toBe("2.0.0-beta.40");
  });

  test("falls back to next when no identifier-named tag exists", () => {
    expect(
      pickDistTag("2.0.0-rc.1", { latest: "0.93.7", next: "2.0.0-rc.2" }),
    ).toBe("2.0.0-rc.2");
  });

  test("falls back to latest when no prerelease channel exists", () => {
    expect(pickDistTag("2.0.0-beta.30", { latest: "0.93.7" })).toBe("0.93.7");
  });

  test("offers latest when it runs ahead of the channel tag (force-latest releases)", () => {
    // Regression: a force-latest beta release left `next` stranded behind
    // `latest` (latest=beta.68, next=beta.67).
    expect(
      pickDistTag("2.0.0-beta.67", {
        latest: "2.0.0-beta.68",
        next: "2.0.0-beta.67",
      }),
    ).toBe("2.0.0-beta.68");
  });
});

describe("compareVersions", () => {
  test("orders prerelease numbers numerically, not lexically", () => {
    expect(compareVersions("2.0.0-beta.68", "2.0.0-beta.67")).toBeGreaterThan(
      0,
    );
    expect(compareVersions("2.0.0-beta.9", "2.0.0-beta.10")).toBeLessThan(0);
  });

  test("release outranks its prereleases", () => {
    expect(compareVersions("2.0.0", "2.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0-rc.1", "2.0.0")).toBeLessThan(0);
  });

  test("core versions compare numerically", () => {
    expect(compareVersions("0.93.7", "0.93.6")).toBeGreaterThan(0);
    expect(compareVersions("0.93.7", "2.0.0-beta.1")).toBeLessThan(0);
  });

  test("equal versions compare as 0 (stale tag must not warn)", () => {
    expect(compareVersions("2.0.0-beta.68", "2.0.0-beta.68")).toBe(0);
  });

  test("alphanumeric prerelease identifiers rank above numeric ones", () => {
    expect(compareVersions("2.0.0-rc.1", "2.0.0-beta.99")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0-beta.1", "2.0.0-1")).toBeGreaterThan(0);
  });
});
