import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyEnvironmentAccentColor,
  environmentAccentStyle,
  resolveEnvironmentAccentColor,
  resolveSharedEnvironmentAccentColor,
} from "./environmentAccentColors";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");
const other = EnvironmentId.make("env-other");

describe("resolveEnvironmentAccentColor", () => {
  it("returns the stored color for an environment", () => {
    expect(resolveEnvironmentAccentColor({ [local]: "#2563eb" }, local)).toBe("#2563eb");
  });

  it("returns undefined for an environment with no color", () => {
    expect(resolveEnvironmentAccentColor({ [local]: "#2563eb" }, remote)).toBeUndefined();
  });

  it("returns undefined without an environment or a settings entry", () => {
    expect(resolveEnvironmentAccentColor(undefined, local)).toBeUndefined();
    expect(resolveEnvironmentAccentColor({ [local]: "#2563eb" }, null)).toBeUndefined();
  });

  it("ignores values that are not usable hex colors", () => {
    expect(resolveEnvironmentAccentColor({ [local]: "rebeccapurple" }, local)).toBeUndefined();
    expect(resolveEnvironmentAccentColor({ [local]: "#25f" }, local)).toBeUndefined();
  });
});

describe("resolveSharedEnvironmentAccentColor", () => {
  it("returns the color shared by every environment", () => {
    expect(
      resolveSharedEnvironmentAccentColor({ [local]: "#2563eb", [remote]: "#2563eb" }, [
        local,
        remote,
      ]),
    ).toBe("#2563eb");
  });

  it("returns undefined when the environments disagree", () => {
    expect(
      resolveSharedEnvironmentAccentColor({ [local]: "#2563eb", [remote]: "#16a34a" }, [
        local,
        remote,
      ]),
    ).toBeUndefined();
  });

  it("returns undefined when only some environments are colored", () => {
    expect(
      resolveSharedEnvironmentAccentColor({ [local]: "#2563eb" }, [local, other]),
    ).toBeUndefined();
  });

  it("returns undefined for an empty environment set", () => {
    expect(resolveSharedEnvironmentAccentColor({ [local]: "#2563eb" }, [])).toBeUndefined();
  });
});

describe("environmentAccentStyle", () => {
  it("tints the glyph's fill by default", () => {
    expect(environmentAccentStyle("#2563eb")).toEqual({ color: "#2563eb" });
  });

  it("tints stroke-drawn glyphs through the stroke property", () => {
    expect(environmentAccentStyle("#2563eb", "stroke")).toEqual({ stroke: "#2563eb" });
  });

  it("leaves the default treatment in place for an uncolored environment", () => {
    expect(environmentAccentStyle(undefined)).toBeUndefined();
    expect(environmentAccentStyle(undefined, "stroke")).toBeUndefined();
  });
});

describe("applyEnvironmentAccentColor", () => {
  it("sets a color without disturbing the other environments", () => {
    expect(applyEnvironmentAccentColor({ [local]: "#2563eb" }, remote, "#16a34a")).toEqual({
      [local]: "#2563eb",
      [remote]: "#16a34a",
    });
  });

  it("replaces an existing color", () => {
    expect(applyEnvironmentAccentColor({ [local]: "#2563eb" }, local, "#dc2626")).toEqual({
      [local]: "#dc2626",
    });
  });

  it("removes the key when the color is cleared", () => {
    expect(
      applyEnvironmentAccentColor({ [local]: "#2563eb", [remote]: "#16a34a" }, local, ""),
    ).toEqual({ [remote]: "#16a34a" });
    expect(applyEnvironmentAccentColor({ [local]: "#2563eb" }, local, undefined)).toEqual({});
  });

  it("drops values that are not usable hex colors instead of storing them", () => {
    expect(applyEnvironmentAccentColor({ [local]: "#2563eb" }, local, "not-a-color")).toEqual({});
  });

  it("does not mutate the settings it was given", () => {
    const accentColors = { [local]: "#2563eb" };
    applyEnvironmentAccentColor(accentColors, local, undefined);
    expect(accentColors).toEqual({ [local]: "#2563eb" });
  });
});
