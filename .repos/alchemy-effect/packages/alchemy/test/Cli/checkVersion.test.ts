import { describe, expect, test } from "@alchemy.run/test";
import { _internal } from "../../src/Cli/checkVersion";

const { compareVersions } = _internal;

describe("compareVersions", { tags: ["unit", "local"] }, () => {
  test("orders prerelease numbers numerically, not lexically", () => {
    expect(compareVersions("2.0.0-beta.68", "2.0.0-beta.67")).toBeGreaterThan(0);
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
