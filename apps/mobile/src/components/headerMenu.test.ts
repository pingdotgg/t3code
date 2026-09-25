import { describe, expect, it } from "vite-plus/test";
import { androidHeaderMenuActions, findHeaderMenuAction } from "./headerMenu.android";
import type { ScreenHeaderMenuItem } from "./ScreenHeader.types";

const items: ReadonlyArray<ScreenHeaderMenuItem> = [
  {
    id: "sessions",
    title: "Sessions",
    items: [
      {
        id: "terminal-session:main",
        title: "Main shell",
        subtitle: "Running · workspace",
        selected: true,
        onPress: () => {},
      },
      { id: "closed", title: "Closed shell", disabled: true, onPress: () => {} },
    ],
  },
];

describe("header menus", () => {
  it("keeps named sections as Android submenus", () => {
    const actions = androidHeaderMenuActions([
      {
        id: "text-size",
        title: "Text size",
        inline: true,
        items: [{ id: "font-increase", title: "A+", onPress: () => {} }],
      },
    ]);
    expect(actions[0]?.title).toBe("Text size");
    expect(actions[0]?.subactions?.[0]?.id).toBe("font-increase");
  });

  it("flattens inline groups while keeping their action IDs", () => {
    const actions = androidHeaderMenuActions([
      { id: "modes", inline: true, items: [{ id: "code", title: "Code", onPress: () => {} }] },
    ]);
    expect(actions.map(({ id }) => id)).toEqual(["code"]);
  });

  it("keeps stable action IDs, selection, and disabled state inside submenus", () => {
    const menu = androidHeaderMenuActions(items);
    expect(menu[0]?.id).toBe("sessions");
    expect(menu[0]?.subactions?.[0]).toMatchObject({
      id: "terminal-session:main",
      title: "Main shell",
      subtitle: "Running · workspace",
      state: "on",
    });
    expect(menu[0]?.subactions?.[1]).toMatchObject({
      id: "closed",
      attributes: { disabled: true },
    });
  });

  it("resolves nested action IDs without dispatching group or missing IDs", () => {
    expect(findHeaderMenuAction(items, "terminal-session:main")).toMatchObject({
      title: "Main shell",
      selected: true,
    });
    expect(findHeaderMenuAction(items, "sessions")).toBeUndefined();
    expect(findHeaderMenuAction(items, "removed-session")).toBeUndefined();
  });
});
