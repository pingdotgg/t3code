import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { getRightPanelMode, parseRightPanelRouteSearch } from "./rightPanelRouteSearch";

describe("parseRightPanelRouteSearch", () => {
  it("keeps preview search when preview is the only open panel", () => {
    expect(parseRightPanelRouteSearch({ preview: "1" })).toEqual({
      preview: "1",
    });
  });

  it("canonicalizes conflicting search state to the diff panel", () => {
    expect(
      parseRightPanelRouteSearch({
        diff: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        preview: "1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: TurnId.make("turn-1"),
      diffFilePath: "src/app.ts",
    });
  });
});

describe("getRightPanelMode", () => {
  it("returns the active panel mode", () => {
    expect(getRightPanelMode({ diff: "1" })).toBe("diff");
    expect(getRightPanelMode({ preview: "1" })).toBe("preview");
    expect(getRightPanelMode({})).toBeNull();
  });
});
