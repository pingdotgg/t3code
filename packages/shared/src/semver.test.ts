import { describe, expect, it } from "vite-plus/test";

import {
  compareSemverVersions,
  normalizeSemverVersion,
  parseSemver,
  satisfiesSemverRange,
} from "./semver.ts";

describe("semver helpers", () => {
  it("matches supported range groups", () => {
    const range = "^22.16 || ^23.11 || >=24.10";

    expect(satisfiesSemverRange("22.16.0", range)).toBe(true);
    expect(satisfiesSemverRange("23.11.1", range)).toBe(true);
    expect(satisfiesSemverRange("24.10.0", range)).toBe(true);
    expect(satisfiesSemverRange("22.15.9", range)).toBe(false);
    expect(satisfiesSemverRange("23.10.9", range)).toBe(false);
    expect(satisfiesSemverRange("24.9.9", range)).toBe(false);
  });

  it("normalizes versions with a missing patch segment", () => {
    expect(normalizeSemverVersion("2.1")).toBe("2.1.0");
  });

  it("normalizes and parses shorthand major-only versions", () => {
    expect(normalizeSemverVersion("20")).toBe("20.0.0");
    expect(normalizeSemverVersion("v18")).toBe("v18.0.0");
    expect(normalizeSemverVersion("20-rc.1")).toBe("20.0.0-rc.1");
    expect(parseSemver("20")).toEqual({ major: 20, minor: 0, patch: 0, prerelease: [] });
  });

  it("compares shorthand versions numerically instead of lexically", () => {
    // Regression: "20" vs "9" previously fell back to string comparison, which
    // ordered "20" before "9" ("2" < "9").
    expect(compareSemverVersions("20", "9")).toBeGreaterThan(0);
    expect(compareSemverVersions("18", "18.0.0")).toBe(0);
  });

  it("still rejects non-numeric shorthand and keeps empty input empty", () => {
    expect(parseSemver("abc")).toBeNull();
    expect(normalizeSemverVersion("")).toBe("");
  });

  it("compares prerelease versions before stable versions", () => {
    expect(compareSemverVersions("2.1.111-beta.1", "2.1.111")).toBeLessThan(0);
  });

  it("preserves hyphens inside prerelease identifiers", () => {
    // Regression: split("-", 2) discarded everything after a second hyphen,
    // so "1.2.3-alpha-1" normalized to "1.2.3-alpha".
    expect(normalizeSemverVersion("1.2.3-alpha-1")).toBe("1.2.3-alpha-1");
    expect(normalizeSemverVersion("1.0.0-beta.2-extra")).toBe("1.0.0-beta.2-extra");
    expect(parseSemver("1.2.3-alpha-1")?.prerelease).toEqual(["alpha-1"]);
    expect(compareSemverVersions("1.2.3-alpha", "1.2.3-alpha-1")).not.toBe(0);
  });

  it("ignores build metadata in precedence", () => {
    // Regression (Codex review on this PR): build metadata must not affect
    // precedence, matching compareExactServiceVersions in serviceProtocol.ts.
    expect(normalizeSemverVersion("1.2.3-alpha-1+build")).toBe("1.2.3-alpha-1");
    expect(parseSemver("1.2.3-alpha-1+build")?.prerelease).toEqual(["alpha-1"]);
    expect(compareSemverVersions("1.2.3-alpha-1+one", "1.2.3-alpha-1+two")).toBe(0);
    expect(compareSemverVersions("1.0.0+build.1", "1.0.0")).toBe(0);
  });

  it("keeps malformed build metadata unparseable", () => {
    // Regression (Codex review on this PR): only a nonempty dot-separated
    // sequence of valid identifiers may be ignored for precedence.
    expect(parseSemver("1.2.3+")).toBeNull();
    expect(parseSemver("1.2.3+not valid")).toBeNull();
    expect(normalizeSemverVersion("1.2.3+build.1")).toBe("1.2.3");
  });

  it("keeps build metadata unparseable when normalization would repair it", () => {
    // Regression (Codex + Bugbot reviews): normalize drops empty dot
    // segments, which must not launder a malformed suffix into a valid one.
    expect(parseSemver("1.2.3+foo.")).toBeNull();
    expect(parseSemver("1.2.3+foo..bar")).toBeNull();
  });

  it("rejects empty prerelease identifiers", () => {
    // Regression (CodeRabbit review): 1.2.3-+build normalized into 1.2.3.
    expect(parseSemver("1.2.3-+build")).toBeNull();
    expect(parseSemver("1.2.3-")).toBeNull();
  });

  it("compares prerelease identifiers in ASCII order", () => {
    // Regression (Codex review on this PR): semver identifiers with letters
    // or hyphens compare lexically in ASCII order, so Z precedes a.
    expect(compareSemverVersions("1.2.3-alpha-Z", "1.2.3-alpha-a")).toBeLessThan(0);
    expect(compareSemverVersions("1.2.3-alpha", "1.2.3-alpha")).toBe(0);
  });

  it("falls back to lexical comparison for malformed numeric segments", () => {
    expect(compareSemverVersions("1.2.3abc", "1.2.10")).toBeGreaterThan(0);
  });

  it("supports comparison comparators", () => {
    expect(satisfiesSemverRange("24.9.0", ">=24.0 <24.10")).toBe(true);
    expect(satisfiesSemverRange("24.10.0", ">=24.0 <24.10")).toBe(false);
  });

  it("honors caret range upper bounds for zero-major versions", () => {
    expect(satisfiesSemverRange("0.2.3", "^0.2.3")).toBe(true);
    expect(satisfiesSemverRange("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfiesSemverRange("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfiesSemverRange("0.5.0", "^0.2.3")).toBe(false);
    expect(satisfiesSemverRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesSemverRange("0.0.4", "^0.0.3")).toBe(false);
  });

  it("rejects invalid versions and unsupported range syntax", () => {
    expect(satisfiesSemverRange("not-a-version", ">=24.0")).toBe(false);
    expect(satisfiesSemverRange("24.10.0", "~24.10")).toBe(false);
  });

  it("keeps the range checker stringifiable and executable as plain JavaScript", () => {
    const source = satisfiesSemverRange.toString();
    const recreated = Function(`return (${source});`)() as typeof satisfiesSemverRange;

    expect(source).toContain("function satisfiesSemverRange");
    expect(source).not.toContain(": string");
    expect(source).not.toContain(": boolean");
    expect(recreated("24.10.0", ">=24.10")).toBe(true);
    expect(recreated("24.9.9", ">=24.10")).toBe(false);
  });
});
