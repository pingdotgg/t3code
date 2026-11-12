import type { CodeViewScrollTarget } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { createCodeViewFileReveal } from "./useCodeViewFileReveal";

function viewer(initialItems: ReadonlyArray<string>) {
  const items = new Set(initialItems);
  const scrolls: CodeViewScrollTarget[] = [];
  const collapsed = new Set<string>();
  return {
    items,
    collapsed,
    scrolls,
    getInstance: () => ({}),
    getItem: (id: string) => (items.has(id) ? { collapsed: collapsed.has(id) } : undefined),
    scrollTo: (target: CodeViewScrollTarget) => scrolls.push(target),
  };
}

describe("createCodeViewFileReveal", () => {
  it("scrolls at once to a file the viewer holds", () => {
    const reveal = createCodeViewFileReveal();
    const view = viewer(["a"]);
    reveal.attach(view);

    reveal.request("a");

    expect(view.scrolls).toEqual([{ type: "item", id: "a", align: "start" }]);
    const range = { start: 12, side: "deletions", end: 15, endSide: "additions" } as const;
    view.collapsed.add("a");
    reveal.request("a", range);
    expect(view.scrolls).toHaveLength(1);
    view.collapsed.delete("a");
    reveal.flush();
    expect(view.scrolls.at(-1)).toEqual({ type: "range", id: "a", range, align: "center" });
  });

  it("keeps a missing file pending until a flush finds it, then drops it", () => {
    const reveal = createCodeViewFileReveal();
    const view = viewer([]);
    reveal.attach(view);

    reveal.request("a");
    reveal.flush();
    expect(view.scrolls).toEqual([]);

    view.items.add("a");
    reveal.flush();
    reveal.flush();
    expect(view.scrolls).toHaveLength(1);
  });

  it("applies a reveal asked before the viewer mounted once it holds the file", () => {
    const reveal = createCodeViewFileReveal();
    const view = viewer([]);

    reveal.request("a");
    reveal.attach(view);
    expect(view.scrolls).toEqual([]);

    view.items.add("a");
    reveal.flush();
    expect(view.scrolls).toEqual([{ type: "item", id: "a", align: "start" }]);
  });

  it("renders the destination file and expands context before positioning its range", () => {
    const reveal = createCodeViewFileReveal();
    const view = viewer(["a"]);
    let rendered = false;
    let expanded = false;
    const instance = {
      revealLine: () => {
        if (expanded) return false;
        expanded = true;
        return true;
      },
      getLinePosition: () => (expanded ? { top: 100, height: 20 } : undefined),
    };
    reveal.attach({
      ...view,
      getInstance: () => ({ getRenderedItems: () => (rendered ? [{ id: "a", instance }] : []) }),
    });
    const range = { start: 12, end: 15, side: "additions" } as const;
    reveal.request("a", range);
    expect(view.scrolls).toEqual([{ type: "item", id: "a", align: "start" }]);
    rendered = true;
    reveal.flush();
    expect(expanded).toBe(true);
    expect(view.scrolls).toHaveLength(1);
    reveal.flush();
    expect(view.scrolls.at(-1)).toEqual({ type: "range", id: "a", range, align: "center" });
  });

  it("expands a patch-only file to an unchanged line before positioning it", () => {
    const reveal = createCodeViewFileReveal();
    const view = viewer(["a"]);
    let partial = true;
    const expanded: unknown[] = [];
    const instance = {
      getDiffForSearch: () =>
        ({
          isPartial: partial,
          hunks: [{ additionStart: 10, additionCount: 5, deletionStart: 10, deletionCount: 5 }],
        }) as never,
      expandHunk: (...args: unknown[]) => expanded.push(args),
      revealLine: () => false,
      getLinePosition: () => ({ top: 100, height: 20 }),
    };
    reveal.attach({
      ...view,
      getInstance: () => ({ getRenderedItems: () => [{ id: "a", instance }] }),
    });
    const range = { start: 30, end: 30, side: "additions" } as const;
    reveal.request("a", range);
    expect(expanded).toEqual([[1, "up", 26]]);
    reveal.flush();
    expect(view.scrolls).toEqual([]);
    // The expander loads the file; the next render holds the line.
    partial = false;
    reveal.flush();
    expect(view.scrolls).toEqual([{ type: "range", id: "a", range, align: "center" }]);

    // Removed lines always sit in a hunk, and a deleted file has no contents to load.
    const deleted = viewer(["d"]);
    const removedRange = { start: 3, end: 4, side: "deletions" } as const;
    reveal.attach({
      ...deleted,
      getInstance: () => ({
        getRenderedItems: () => [
          {
            id: "d",
            instance: {
              ...instance,
              getDiffForSearch: () =>
                ({
                  isPartial: true,
                  hunks: [
                    { additionStart: 0, additionCount: 0, deletionStart: 1, deletionCount: 8 },
                  ],
                }) as never,
            },
          },
        ],
      }),
    });
    reveal.request("d", removedRange);
    expect(expanded).toHaveLength(1);
    expect(deleted.scrolls).toEqual([
      { type: "range", id: "d", range: removedRange, align: "center" },
    ]);
  });

  it("drops a pending reveal when another diff's viewer replaces it, but repositions a range a remount loses", () => {
    const reveal = createCodeViewFileReveal();
    const first = viewer([]);
    // Item ids carry the diff's scope, so another diff's viewer holds other ids.
    const second = viewer(["b"]);
    reveal.attach(first);

    reveal.request("a");
    reveal.attach(null);
    reveal.attach(second);
    second.items.add("a");
    reveal.flush();
    expect(second.scrolls).toEqual([]);

    reveal.request("a");
    expect(second.scrolls).toHaveLength(1);

    // The first diff load remounts the viewer right after a range scroll, so it is repeated once.
    const range = { start: 3, end: 4, side: "additions" } as const;
    const remounted = viewer(["a"]);
    reveal.request("a", range);
    reveal.attach(null);
    reveal.attach(remounted);
    reveal.flush();
    expect(remounted.scrolls).toEqual([{ type: "range", id: "a", range, align: "center" }]);

    // Scrolling away before that second pass keeps the user where they went.
    const scrolledAway = viewer(["a"]);
    reveal.request("a", range);
    reveal.cancel();
    reveal.attach(null);
    reveal.attach(scrolledAway);
    reveal.flush();
    expect(scrolledAway.scrolls).toEqual([]);
  });
});
