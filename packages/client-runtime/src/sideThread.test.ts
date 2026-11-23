import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveMobileSideThreadPresentation,
  resolveSideThreadOpenTarget,
  sideThreadComposer,
  sideThreadKindOf,
  sideThreadOpenIntentOf,
} from "./sideThread.ts";

const parentThreadId = ThreadId.make("parent");
const lineage = (
  overrides: Partial<{
    parentThreadId: ThreadId | null;
    relationshipToParent: "fork" | "subagent" | null;
    sideChat: boolean;
  }>,
) => ({
  lineage: {
    rootThreadId: parentThreadId,
    parentThreadId,
    relationshipToParent: null,
    forkedFrom: null,
    ...overrides,
  },
});

describe("sideThreadKindOf", () => {
  it.each([
    ["a side chat", lineage({ relationshipToParent: "fork", sideChat: true }), "side-chat"],
    ["an app subagent", { ...lineage({ relationshipToParent: "subagent" }) }, "subagent"],
    [
      "a provider's own subagent",
      { ...lineage({ relationshipToParent: "subagent" }), creationSource: "provider" as const },
      "provider-subagent",
    ],
    ["a fork", lineage({ relationshipToParent: "fork" }), null],
    ["a top-level thread", lineage({ parentThreadId: null }), null],
    // The flag alone does not make a tab: a side chat is beside some thread.
    ["a side chat with no parent", lineage({ parentThreadId: null, sideChat: true }), null],
  ])("classifies %s", (_name, thread, kind) => {
    expect(sideThreadKindOf(thread as Parameters<typeof sideThreadKindOf>[0])).toBe(kind);
  });

  it("treats a thread that is not loaded as an ordinary one", () => {
    expect(sideThreadKindOf(null)).toBeNull();
  });
});

describe("sideThreadComposer", () => {
  it.each([
    ["side-chat", "composer"],
    ["subagent", "composer"],
    ["provider-subagent", "read-only"],
    ["linked", "read-only-connect"],
  ] as const)("gives %s the %s", (kind, composer) => {
    expect(sideThreadComposer(kind)).toBe(composer);
  });
});

describe("resolveSideThreadOpenTarget", () => {
  it.each([
    // preference, intent, panelAvailable, target
    ["panel", "primary", true, "panel"],
    ["panel", "alternate", true, "main"],
    ["main", "primary", true, "main"],
    ["main", "alternate", true, "panel"],
    // The context menu names a place, whatever the preference.
    ["panel", "main", true, "main"],
    ["main", "panel", true, "panel"],
    // With no panel to open in, every way of asking lands on the main view.
    ["panel", "primary", false, "main"],
    ["main", "alternate", false, "main"],
    ["main", "panel", false, "main"],
  ] as const)(
    "prefers %s, asked %s, panel %s: opens in %s",
    (preference, intent, panelAvailable, target) => {
      expect(resolveSideThreadOpenTarget({ preference, intent, panelAvailable })).toBe(target);
    },
  );
});

describe("sideThreadOpenIntentOf", () => {
  const plain = { metaKey: false, ctrlKey: false, button: 0 };

  it("takes the platform's modifier and the middle button as the other place", () => {
    expect(sideThreadOpenIntentOf(plain, true)).toBe("primary");
    expect(sideThreadOpenIntentOf({ ...plain, metaKey: true }, true)).toBe("alternate");
    expect(sideThreadOpenIntentOf({ ...plain, ctrlKey: true }, false)).toBe("alternate");
    expect(sideThreadOpenIntentOf({ ...plain, button: 1 }, false)).toBe("alternate");
    // A key press has no button.
    expect(sideThreadOpenIntentOf({ metaKey: true, ctrlKey: false }, true)).toBe("alternate");
  });

  it("ignores the other platform's modifier", () => {
    // Ctrl-click on macOS is the context menu, and the Windows key is not Ctrl.
    expect(sideThreadOpenIntentOf({ ...plain, ctrlKey: true }, true)).toBe("primary");
    expect(sideThreadOpenIntentOf({ ...plain, metaKey: true }, false)).toBe("primary");
  });
});

describe("resolveMobileSideThreadPresentation", () => {
  it("uses the inspector wherever the layout has one, else the full screen", () => {
    expect(resolveMobileSideThreadPresentation({ inspectorAvailable: true })).toBe("inspector");
    expect(resolveMobileSideThreadPresentation({ inspectorAvailable: false })).toBe("full-screen");
  });
});
