import { describe, expect, it } from "vite-plus/test";

import {
  groupAdjacentElements,
  isDefaultSurfaceLayout,
  moveSurfaceElement,
  moveSurfaceElementBefore,
  resetSurfaceLayout,
  resolveSurfaceLayout,
  setSurfaceElementHidden,
} from "./interfaceLayout";

describe("resolveSurfaceLayout", () => {
  it("uses the default arrangement when nothing is saved", () => {
    const resolved = resolveSurfaceLayout("chatHeader", {});
    expect(resolved.order).toEqual(["scripts", "openIn", "git"]);
    expect(resolved.hidden.size).toBe(0);
  });

  it("keeps fixed elements in place while sortable ones follow the saved order", () => {
    const resolved = resolveSurfaceLayout("threadRow", {
      threadRow: { order: ["provider", "branch"], hidden: [] },
    });
    expect(resolved.order).toEqual([
      "project",
      "status",
      "provider",
      "branch",
      "terminal",
      "pullRequest",
      "environment",
    ]);
  });

  it("drops unknown and duplicate ids from another build", () => {
    const resolved = resolveSurfaceLayout("chatHeader", {
      chatHeader: { order: ["git", "retired", "git", "scripts"], hidden: ["retired", "openIn"] },
    });
    expect(resolved.order).toEqual(["git", "scripts", "openIn"]);
    expect([...resolved.hidden]).toEqual(["openIn"]);
  });

  it("slots an element the saved order predates next to its default neighbour", () => {
    // `openIn` is missing, as if it were added after this layout was saved.
    const resolved = resolveSurfaceLayout("chatHeader", {
      chatHeader: { order: ["git", "scripts"], hidden: [] },
    });
    expect(resolved.order).toEqual(["git", "scripts", "openIn"]);
  });

  it("never hides a required element", () => {
    const resolved = resolveSurfaceLayout("composerContextBar", {
      composerContextBar: { order: [], hidden: ["controls", "branch"] },
    });
    expect([...resolved.hidden]).toEqual(["branch"]);
  });
});

describe("interface layout edits", () => {
  it("moves an element to the slot it was dropped on", () => {
    const layout = moveSurfaceElement({}, "composerContextBar", "controls", "workspace");
    expect(resolveSurfaceLayout("composerContextBar", layout).order).toEqual([
      "controls",
      "workspace",
      "branch",
    ]);
  });

  it("hides and restores an element", () => {
    const hidden = setSurfaceElementHidden({}, "threadRow", "terminal", true);
    expect(resolveSurfaceLayout("threadRow", hidden).hidden.has("terminal")).toBe(true);
    const restored = setSurfaceElementHidden(hidden, "threadRow", "terminal", false);
    expect(restored).toEqual({});
  });

  it("stores nothing once a surface is back at its defaults", () => {
    const moved = moveSurfaceElement({}, "chatHeader", "git", "scripts");
    expect(isDefaultSurfaceLayout("chatHeader", moved)).toBe(false);
    const movedBack = moveSurfaceElement(moved, "chatHeader", "git", "openIn");
    expect(movedBack).toEqual({});
  });

  it("resets one surface without touching the others", () => {
    const layout = setSurfaceElementHidden(
      moveSurfaceElement({}, "chatHeader", "git", "scripts"),
      "threadRow",
      "provider",
      true,
    );
    expect(resetSurfaceLayout(layout, "chatHeader")).toEqual({
      threadRow: {
        order: ["branch", "terminal", "pullRequest", "environment", "provider"],
        hidden: ["provider"],
      },
    });
  });
});

describe("layouts from a newer build", () => {
  // `voice` stands in for an element only a newer build knows about.
  const newer = {
    chatHeader: { order: ["git", "voice", "scripts", "openIn"], hidden: ["voice"] },
  };

  it("keeps unknown ids through a hide and unhide", () => {
    const hidden = setSurfaceElementHidden(newer, "chatHeader", "openIn", true);
    expect(hidden.chatHeader).toEqual({
      order: ["git", "voice", "scripts", "openIn"],
      hidden: ["voice", "openIn"],
    });
    const restored = setSurfaceElementHidden(hidden, "chatHeader", "openIn", false);
    expect(restored.chatHeader).toEqual({
      order: ["git", "voice", "scripts", "openIn"],
      hidden: ["voice"],
    });
  });

  it("keeps an unknown id after the known element it followed when moving", () => {
    const moved = moveSurfaceElementBefore(newer, "chatHeader", "openIn", "git");
    expect(moved.chatHeader?.order).toEqual(["openIn", "git", "voice", "scripts"]);
    const movedGit = moveSurfaceElementBefore(newer, "chatHeader", "git", null);
    expect(movedGit.chatHeader?.order).toEqual(["scripts", "openIn", "git", "voice"]);
  });

  it("keeps the surface stored while it carries unknown ids at known defaults", () => {
    const layout = {
      chatHeader: { order: ["scripts", "openIn", "git"], hidden: ["voice", "openIn"] },
    };
    expect(setSurfaceElementHidden(layout, "chatHeader", "openIn", false)).toEqual({
      chatHeader: { order: ["scripts", "openIn", "git"], hidden: ["voice"] },
    });
  });

  it("keeps surfaces this build does not know", () => {
    const layout = { futureSurface: { order: ["a"], hidden: ["b"] } };
    expect(setSurfaceElementHidden(layout, "chatHeader", "git", true)).toEqual({
      futureSurface: { order: ["a"], hidden: ["b"] },
      chatHeader: { order: ["scripts", "openIn", "git"], hidden: ["git"] },
    });
  });
});

describe("groupAdjacentElements", () => {
  const icons = new Set(["environment", "provider"]);

  it("keeps adjacent grouped elements together", () => {
    expect(groupAdjacentElements(["branch", "environment", "provider"], icons)).toEqual([
      "branch",
      ["environment", "provider"],
    ]);
  });

  it("splits grouped elements that another element separates", () => {
    expect(groupAdjacentElements(["provider", "branch", "environment"], icons)).toEqual([
      ["provider"],
      "branch",
      ["environment"],
    ]);
  });
});

describe("moveSurfaceElementBefore", () => {
  it("places an element before another", () => {
    const layout = moveSurfaceElementBefore({}, "threadRow", "provider", "branch");
    expect(resolveSurfaceLayout("threadRow", layout).order).toEqual([
      "project",
      "status",
      "provider",
      "branch",
      "terminal",
      "pullRequest",
      "environment",
    ]);
  });

  it("moves an element to the end when there is nothing after it", () => {
    const layout = moveSurfaceElementBefore({}, "chatHeader", "scripts", null);
    expect(resolveSurfaceLayout("chatHeader", layout).order).toEqual(["openIn", "git", "scripts"]);
  });

  it("leaves the layout untouched when the order would not change", () => {
    const layout = {};
    expect(moveSurfaceElementBefore(layout, "chatHeader", "scripts", "openIn")).toBe(layout);
    expect(moveSurfaceElementBefore(layout, "chatHeader", "attach", null)).toBe(layout);
  });
});
