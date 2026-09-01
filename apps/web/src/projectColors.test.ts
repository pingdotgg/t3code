import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_COLOR_OPTIONS,
  PROJECT_COLOR_VALUES,
  projectColorCssValue,
  resolveProjectGroupColor,
} from "./projectColors";

describe("projectColorCssValue", () => {
  it("maps every palette name to its literal theme variable", () => {
    for (const option of PROJECT_COLOR_OPTIONS) {
      expect(projectColorCssValue(option.name)).toBe(PROJECT_COLOR_VALUES[option.name]);
    }
  });

  it("passes through raw hex colors", () => {
    expect(projectColorCssValue("#2563eb")).toBe("#2563eb");
  });

  it("renders nothing for unset or unknown values", () => {
    expect(projectColorCssValue(null)).toBeNull();
    expect(projectColorCssValue(undefined)).toBeNull();
    expect(projectColorCssValue("")).toBeNull();
    expect(projectColorCssValue("chartreuse-from-the-future")).toBeNull();
  });
});

describe("resolveProjectGroupColor", () => {
  it("prefers the representative's color over member order", () => {
    expect(
      resolveProjectGroupColor({
        color: "blue",
        memberProjects: [{ color: "red" }, { color: "blue" }],
      }),
    ).toBe("blue");
  });

  it("falls back to the first colored member when the representative has none", () => {
    expect(
      resolveProjectGroupColor({
        color: null,
        memberProjects: [{ color: null }, { color: "teal" }],
      }),
    ).toBe("teal");
  });

  it("returns null for an uncolored group", () => {
    expect(resolveProjectGroupColor({ color: null, memberProjects: [{}, { color: null }] })).toBe(
      null,
    );
  });
});
