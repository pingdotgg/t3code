import { expect, it } from "vite-plus/test";

import { buildThreadTitleMenu } from "./threadOverflowMenu";

it("builds a title menu from lifecycle items only", () => {
  const menu = buildThreadTitleMenu([
    { id: "settle", title: "Settle thread", icon: "checkmark", onPress: () => {} },
    {
      id: "snooze",
      title: "Snooze",
      icon: "clock",
      items: [{ id: "snooze:custom", title: "Custom…", onPress: () => {} }],
    },
  ]);

  expect(menu).toMatchObject({
    title: "Thread actions",
    icon: "ellipsis.circle",
  });
  expect(menu?.items.map((item) => item.id)).toEqual(["settle", "snooze"]);
});

it("returns null when nothing is available", () => {
  expect(buildThreadTitleMenu([])).toBeNull();
});
