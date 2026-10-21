import { describe, expect, it } from "vite-plus/test";
import { splitAndroidHeaderActions } from "./headerMenu.android";

describe("header menus", () => {
  it("keeps overflow-only Android header actions in the overflow menu", () => {
    const action = (accessibilityLabel: string, overflowOnly?: boolean) => ({
      accessibilityLabel,
      icon: "trash" as const,
      onPress: () => {},
      overflowOnly,
    });
    const labels = (
      split: ReturnType<typeof splitAndroidHeaderActions<ReturnType<typeof action>>>,
    ) => ({
      visible: split.visibleActions.map((item) => item.accessibilityLabel),
      overflow: split.overflowActions.map((item) => item.accessibilityLabel),
    });
    const open = action("Open");
    const remove = action("Delete", true);
    expect(labels(splitAndroidHeaderActions([open, action("Comment")], false))).toEqual({
      visible: ["Open", "Comment"],
      overflow: [],
    });
    expect(labels(splitAndroidHeaderActions([open, remove], true))).toEqual({
      visible: ["Open"],
      overflow: ["Delete"],
    });
    expect(labels(splitAndroidHeaderActions([remove], true))).toEqual({
      visible: [],
      overflow: ["Delete"],
    });
    expect(
      labels(splitAndroidHeaderActions([action("Review"), action("Comment"), open, remove], true)),
    ).toEqual({ visible: ["Review", "Comment", "Open"], overflow: ["Delete"] });
  });
});
