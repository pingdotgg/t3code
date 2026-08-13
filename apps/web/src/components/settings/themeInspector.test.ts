import { describe, expect, it } from "@effect/vitest";

import {
  changedThemePaintKinds,
  themeRoleFromUtilityClass,
  type ThemePaintSnapshot,
} from "./themeInspector";

const WHITE_PAINT: ThemePaintSnapshot = {
  background: "rgb(255, 255, 255)\nnone",
  border: "rgb(255, 255, 255)\nnone",
  foreground: "rgb(255, 255, 255)\nnone",
};

describe("changedThemePaintKinds", () => {
  it("does not match an identical hardcoded color", () => {
    expect(changedThemePaintKinds(WHITE_PAINT, { ...WHITE_PAINT })).toEqual([]);
  });

  it("reports only paint that changed with the probed token", () => {
    expect(
      changedThemePaintKinds(WHITE_PAINT, {
        ...WHITE_PAINT,
        background: "rgb(1, 254, 167)\nnone",
        foreground: "rgb(1, 254, 167)\nnone",
      }),
    ).toEqual(["background", "foreground"]);
  });
});

describe("themeRoleFromUtilityClass", () => {
  it("maps semantic utilities to their actual palette role", () => {
    expect(themeRoleFromUtilityClass("text-foreground", "foreground")).toBe("text");
    expect(themeRoleFromUtilityClass("text-muted-foreground", "foreground")).toBe(
      "mutedForeground",
    );
    expect(themeRoleFromUtilityClass("bg-primary/90", "background")).toBe("messageAction");
    expect(themeRoleFromUtilityClass("ring-ring", "border")).toBe("focus");
  });

  it("does not infer hardcoded or potentially inactive colors", () => {
    expect(themeRoleFromUtilityClass("bg-white", "background")).toBeNull();
    expect(themeRoleFromUtilityClass("hover:bg-accent", "background")).toBeNull();
  });
});
