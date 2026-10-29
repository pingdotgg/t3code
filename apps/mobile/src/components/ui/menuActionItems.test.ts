import type { MenuAction } from "@react-native-menu/menu";
import { describe, expect, it, vi } from "vitest";

import { androidHeaderMenuActions, findHeaderMenuAction } from "./headerMenu.android";
import { appBarMenuItemsFromActions } from "./menuActionItems";

describe("appBarMenuItemsFromActions", () => {
  it("round-trips a filter menu through AppBar items back to Android actions", () => {
    const actions: MenuAction[] = [
      {
        id: "labels",
        title: "Labels",
        subactions: [
          {
            id: "label:bug",
            title: "bug",
            image: "circle.fill",
            imageColor: "#d73a4a",
            state: "on",
          },
          { id: "label:docs", title: "docs", subtitle: "3 open", state: "off" },
        ],
      },
    ];
    const onSelect = vi.fn();

    const items = appBarMenuItemsFromActions(actions, onSelect);

    expect(androidHeaderMenuActions(items)).toEqual([
      {
        id: "labels",
        title: "Labels",
        image: undefined,
        subactions: [
          {
            id: "label:bug",
            title: "bug",
            subtitle: undefined,
            image: "circle.fill",
            imageColor: "#d73a4a",
            state: "on",
            attributes: undefined,
          },
          {
            id: "label:docs",
            title: "docs",
            subtitle: "3 open",
            image: undefined,
            imageColor: undefined,
            state: undefined,
            attributes: undefined,
          },
        ],
      },
    ]);
    findHeaderMenuAction(items, "label:docs")?.onPress();
    expect(onSelect).toHaveBeenCalledWith("label:docs");
  });
});
