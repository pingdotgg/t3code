import { describe, expect, it } from "vite-plus/test";

import { flattenInlineMenuSections } from "./android-menu-sections";

describe("flattenInlineMenuSections", () => {
  it("flattens inline groups and places a divider before each group", () => {
    const entries = flattenInlineMenuSections([
      { id: "settle", title: "Settle" },
      {
        id: "title-actions",
        title: "",
        displayInline: true,
        subactions: [
          { id: "rename", title: "Rename" },
          { id: "regenerate", title: "Regenerate" },
        ],
      },
      {
        id: "delete-actions",
        title: "",
        displayInline: true,
        subactions: [{ id: "delete", title: "Delete" }],
      },
    ]);

    expect(entries.map(({ action }) => action.id)).toEqual([
      "settle",
      "rename",
      "regenerate",
      "delete",
    ]);
    expect(entries.map(({ dividerBefore }) => dividerBefore)).toEqual([false, true, false, true]);
  });

  it("keeps regular submenus nested", () => {
    const snooze = {
      id: "snooze",
      title: "Snooze",
      subactions: [{ id: "tomorrow", title: "Tomorrow" }],
    };
    expect(flattenInlineMenuSections([snooze])).toEqual([{ action: snooze, dividerBefore: false }]);
  });
});
