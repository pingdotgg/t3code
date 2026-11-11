import type { MenuAction } from "@react-native-menu/menu";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  appBarMenuItemsFromActions,
  findAppBarMenuItem,
  menuActionsFromAppBarItems,
} from "./menuActionItems";

describe("appBarMenuItemsFromActions", () => {
  it("round-trips a filter menu through AppBar items back to menu actions", () => {
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

    expect(menuActionsFromAppBarItems(items)).toEqual([
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
    findAppBarMenuItem(items, "label:docs")?.onPress();
    expect(onSelect).toHaveBeenCalledWith("label:docs");
    expect(
      menuActionsFromAppBarItems([{ id: "devices", title: "Devices", inline: true, items: [] }]),
    ).toMatchObject([{ id: "devices", title: "Devices", displayInline: true }]);
  });
});
