import { describe, expect, it } from "vite-plus/test";

import { checkedItemRole } from "./menuCheckedRole";

describe("checkedItemRole", () => {
  it.each([
    ["a lone checked item as a checkbox", "menuitemcheckbox", [{}, { checked: true }]],
    [
      "checked items of one list as a choice of one",
      "menuitemradio",
      [{ checked: false }, { checked: true }],
    ],
  ] as const)("announces %s", (_name, role, entries) => {
    expect(checkedItemRole(entries)).toBe(role);
  });
});
