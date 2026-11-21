import type { CodeViewScrollTarget } from "@pierre/diffs";
import { describe, expect, it, vi } from "vite-plus/test";

import { createCodeViewScrollRestore } from "./useCodeViewScrollRestore";

const LINE_HEIGHT = 20;

// Files stacked from the given tops, each a 32px header followed by 20px lines.
function viewer(tops: Record<string, number>, collapsed: readonly string[] = []) {
  const items = new Map(Object.entries(tops));
  const instance = {
    scrollTop: 0,
    rendered: null as string[] | null,
    getHeight: () => 500,
    getScrollTop: () => instance.scrollTop,
    getTopForItem: (id: string) => items.get(id),
    getRenderedItems: () =>
      (instance.rendered ?? [...items.keys()]).map((id) => ({
        id,
        instance: {
          getNumericScrollAnchor: (localTop: number) => {
            if (collapsed.includes(id)) return undefined;
            const lineNumber = Math.ceil((localTop - 32) / LINE_HEIGHT) + 1;
            return { lineNumber, top: 32 + (lineNumber - 1) * LINE_HEIGHT };
          },
        },
      })),
  };
  const scrolls: CodeViewScrollTarget[] = [];
  return {
    instance,
    items,
    scrolls,
    getInstance: () => instance,
    getItem: (id: string) => (items.has(id) ? { collapsed: collapsed.includes(id) } : undefined),
    scrollTo: (target: CodeViewScrollTarget) => scrolls.push(target),
  };
}

function mount(
  scopeKey: string,
  view: ReturnType<typeof viewer>,
  settled = true,
  loadMore: (() => void) | null = null,
) {
  const restore = createCodeViewScrollRestore();
  restore.update(scopeKey, settled, loadMore);
  restore.attach(view);
  return restore;
}

function setup() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  const runFrame = () => {
    for (const callback of frames.splice(0)) callback(0);
  };
  const runFrames = () => {
    while (frames.length > 0) runFrame();
  };
  const scroll = (
    restore: ReturnType<typeof mount>,
    view: ReturnType<typeof viewer>,
    top: number,
  ) => {
    view.instance.scrollTop = top;
    restore.onScroll(top, view.instance);
    runFrames();
  };
  return { runFrame, runFrames, scroll };
}

describe("createCodeViewScrollRestore", () => {
  it("puts a remounted viewer back on its scope's file and line, not its pixel offset", () => {
    const { scroll } = setup();
    const first = viewer({ a: 0, b: 4000, c: 9000 });
    // 104px into file b: line 7 is the first under the sticky header, 16px below its edge.
    scroll(mount("thread-a", first), first, 4104);
    const other = viewer({ a: 0, b: 4000 });
    scroll(mount("thread-b", other), other, 1200);

    // The remounted viewer estimates file a shorter, so file b starts elsewhere.
    const again = viewer({ a: 0, b: 2500, c: 6000 });
    mount("thread-a", again);
    expect(again.scrolls).toEqual([
      { type: "line", id: "b", align: "start", lineNumber: 7, offset: 16 },
    ]);
  });

  it("reads the anchor from the viewport Pierre renders after the scroll, not the one before", () => {
    const { runFrame, runFrames } = setup();
    const first = viewer({ a: 0, b: 4000, c: 8000 });
    first.instance.rendered = ["a"];
    const restore = mount("thread-e", first);
    first.instance.scrollTop = 104;
    restore.onScroll(104, first.instance);
    runFrame();
    // The drag goes on to file c between the frames and notifies before the viewer renders it.
    first.instance.scrollTop = 8104;
    restore.onScroll(8104, first.instance);
    runFrame();
    first.instance.rendered = ["c"];
    runFrames();

    const again = viewer({ a: 0, b: 2500, c: 6000 });
    mount("thread-e", again);
    expect(again.scrolls).toEqual([
      { type: "line", id: "c", align: "start", lineNumber: 7, offset: 16 },
    ]);
  });

  it("loads more files until the anchored file has loaded, then falls back to the file", () => {
    const { scroll } = setup();
    const first = viewer({ a: 0, b: 4000 });
    scroll(mount("thread-c", first), first, 4104);

    const loading = viewer({ a: 0 });
    let batches = 0;
    const restore = mount("thread-c", loading, false, () => {
      batches += 1;
    });
    scroll(restore, loading, 0);
    restore.flush();
    expect(loading.scrolls).toEqual([]);
    expect(batches).toBe(2);
    loading.items.set("b", 700);
    restore.flush();
    restore.flush();
    expect(loading.scrolls).toEqual([
      { type: "line", id: "b", align: "start", lineNumber: 7, offset: 16 },
    ]);

    const pending = viewer({ a: 0, b: 700 }, ["b"]);
    const settling = mount("thread-c", pending, false);
    settling.flush();
    expect(pending.scrolls).toEqual([]);
    settling.update("thread-c", true, null);
    settling.flush();
    expect(pending.scrolls).toEqual([{ type: "item", id: "b", align: "start", offset: -104 }]);
  });

  it("forgets a position that a reveal or collapsing every file replaced", () => {
    const { scroll } = setup();
    const first = viewer({ a: 0, b: 4000 });
    const restore = mount("thread-d", first);
    scroll(restore, first, 4104);
    restore.discard();

    const again = viewer({ a: 0, b: 4000 });
    mount("thread-d", again);
    expect(again.scrolls).toEqual([]);
  });
});
