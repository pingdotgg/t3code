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

  it("drops a pending reveal when its viewer detaches, and positions the next viewer on request", () => {
    const reveal = createCodeViewFileReveal();
    const first = viewer([]);
    const second = viewer(["a"]);
    reveal.attach(first);

    reveal.request("a");
    reveal.attach(null);
    reveal.attach(second);
    reveal.flush();
    expect(second.scrolls).toEqual([]);

    reveal.request("a");
    expect(second.scrolls).toHaveLength(1);
  });
});
