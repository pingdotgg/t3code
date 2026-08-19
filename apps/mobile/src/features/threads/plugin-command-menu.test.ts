import { describe, expect, it } from "vite-plus/test";

import {
  buildMobilePluginCommandItems,
  isCollapsedComposerSelection,
  reconcileComposerSelectionForTextChange,
} from "./plugin-command-menu";

describe("buildMobilePluginCommandItems", () => {
  it("renders only matching mobile command contributions", () => {
    const items = buildMobilePluginCommandItems(
      [
        {
          id: "plugin.mobile-status",
          label: "Check status",
          description: "Verify the runtime",
          surfaces: ["mobile"],
        },
        {
          id: "plugin.web-only",
          label: "Web only",
          surfaces: ["web"],
        },
      ],
      "status",
    );

    expect(items.map((item) => item.id)).toEqual(["plugin-command:plugin.mobile-status"]);
    expect(items[0]?.type).toBe("plugin-command");
  });
});

describe("reconcileComposerSelectionForTextChange", () => {
  it("moves an end-positioned caret after prompt hydration", () => {
    expect(reconcileComposerSelectionForTextChange({ start: 0, end: 0 }, 0, 14)).toEqual({
      start: 14,
      end: 14,
    });
  });
});

describe("isCollapsedComposerSelection", () => {
  it("rejects a highlighted range", () => {
    expect(isCollapsedComposerSelection({ start: 0, end: 7 })).toBe(false);
  });
});
