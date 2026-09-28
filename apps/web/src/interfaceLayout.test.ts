import { describe, expect, it } from "vite-plus/test";

import {
  groupAdjacentElements,
  isDefaultSurfaceLayout,
  moveSurfaceElement,
  moveSurfaceElementBefore,
  resetSurfaceLayout,
  resolveSurfaceLayout,
  setSurfaceElementHidden,
  setSurfaceElementCombined,
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

describe("combined composer elements", () => {
  it("inserts the required model first in old layouts", () => {
    const resolved = resolveSurfaceLayout("composerToolbar", {
      composerToolbar: { order: ["mode", "traits"], hidden: ["model"] },
    });
    expect(resolved.order).toEqual(["model", "mode", "traits", "attach"]);
    expect(resolved.hidden.size).toBe(0);
    expect(resolved.combined.size).toBe(0);
  });

  it("only combines eligible ids and lets hidden win", () => {
    const resolved = resolveSurfaceLayout("composerToolbar", {
      composerToolbar: {
        order: [],
        hidden: ["traits"],
        combined: ["traits", "mode", "model", "unknown"],
      },
    });
    expect(resolved.combined.size).toBe(0);
    expect([
      ...resolveSurfaceLayout("composerToolbar", {
        composerToolbar: {
          order: [],
          hidden: [],
          combined: ["traits", "traits", "mode", "unknown"],
        },
      }).combined,
    ]).toEqual(["traits"]);
    expect(setSurfaceElementCombined({}, "composerToolbar", "mode", true)).toEqual({});
    expect(setSurfaceElementCombined({}, "chatHeader", "traits", true)).toEqual({});
  });

  it("preserves combinations through reordering and unrelated visibility edits", () => {
    const combined = setSurfaceElementCombined({}, "composerToolbar", "traits", true);
    expect(isDefaultSurfaceLayout("composerToolbar", combined)).toBe(false);
    const moved = moveSurfaceElementBefore(combined, "composerToolbar", "model", null);
    const hidden = setSurfaceElementHidden(moved, "composerToolbar", "mode", true);
    expect([...resolveSurfaceLayout("composerToolbar", hidden).combined]).toEqual(["traits"]);
    expect(resolveSurfaceLayout("composerToolbar", hidden).order).toEqual([
      "traits",
      "mode",
      "model",
      "attach",
    ]);
    expect(setSurfaceElementCombined(combined, "composerToolbar", "traits", false)).toEqual({});
    expect(resetSurfaceLayout(combined, "composerToolbar")).toEqual({});
  });

  it("hiding clears a combination and restoring leaves the options separate", () => {
    const combined = setSurfaceElementCombined({}, "composerToolbar", "traits", true);
    const hidden = setSurfaceElementHidden(combined, "composerToolbar", "traits", true);
    expect(resolveSurfaceLayout("composerToolbar", hidden).combined.size).toBe(0);
    expect(setSurfaceElementCombined(hidden, "composerToolbar", "traits", true)).toBe(hidden);
    expect(setSurfaceElementHidden(hidden, "composerToolbar", "traits", false)).toEqual({});
  });
});

const refiningPairs = [
  ["composerToolbar", "traits", "model", "mode"],
  ["composerContextBar", "branch", "workspace", "controls"],
  ["threadRow", "pullRequest", "branch", "terminal"],
] as const;

describe.each(refiningPairs)("%s: %s refines %s", (surface, guest, host, unrelated) => {
  it("accepts only declared guests, ignores duplicates, and preserves old layouts", () => {
    expect([
      ...resolveSurfaceLayout(surface, {
        [surface]: { order: [], hidden: [], combined: [guest, guest, host, unrelated, "unknown"] },
      }).combined,
    ]).toEqual([guest]);
    expect(
      resolveSurfaceLayout(surface, { [surface]: { order: [], hidden: [] } }).combined.size,
    ).toBe(0);
    expect(setSurfaceElementCombined({}, surface, unrelated, true)).toEqual({});
  });

  it("keeps combinations through reorder, supports separation and reset", () => {
    const combined = setSurfaceElementCombined({}, surface, guest, true);
    expect(
      resolveSurfaceLayout(
        surface,
        moveSurfaceElementBefore(combined, surface, host, null),
      ).combined.has(guest),
    ).toBe(true);
    expect(setSurfaceElementCombined(combined, surface, guest, false)).toEqual({});
    expect(resetSurfaceLayout(combined, surface)).toEqual({});
  });

  it("lets hidden guests win and refuses combining them", () => {
    const combined = setSurfaceElementCombined({}, surface, guest, true);
    const hidden = setSurfaceElementHidden(combined, surface, guest, true);
    expect(hidden[surface]?.combined ?? []).toEqual([]);
    expect(resolveSurfaceLayout(surface, hidden).combined.size).toBe(0);
    expect(setSurfaceElementCombined(hidden, surface, guest, true)).toBe(hidden);
    expect(setSurfaceElementHidden(hidden, surface, guest, false)).toEqual({});
    expect(
      resolveSurfaceLayout(surface, {
        [surface]: { order: [], hidden: [guest], combined: [guest] },
      }).combined.size,
    ).toBe(0);
  });

  it("renders guests standalone when their host is hidden, except required hosts", () => {
    const resolved = resolveSurfaceLayout(surface, {
      [surface]: { order: [], hidden: [host], combined: [guest] },
    });
    expect(resolved.hidden.has(guest)).toBe(false);
    expect(resolved.combined.has(guest)).toBe(surface === "composerToolbar");
    if (surface !== "composerToolbar") {
      const hidden = setSurfaceElementHidden(
        setSurfaceElementCombined({}, surface, guest, true),
        surface,
        host,
        true,
      );
      expect(resolveSurfaceLayout(surface, hidden).combined.size).toBe(0);
      expect(setSurfaceElementHidden(hidden, surface, host, false)).toEqual({});
    }
  });
});
