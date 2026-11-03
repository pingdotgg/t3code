import type { CodeViewScrollTarget } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { createCodeViewFileReveal } from "./useCodeViewFileReveal";

function viewer(initialItems: ReadonlyArray<string>) {
  const items = new Set(initialItems);
  const scrolls: CodeViewScrollTarget[] = [];
  return {
    items,
    scrolls,
    getInstance: () => ({}),
    getItem: (id: string) => (items.has(id) ? {} : undefined),
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
