import type { CodeViewScrollTarget } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { createCodeViewScrollRestore } from "./useCodeViewScrollRestore";

const LINE_HEIGHT = 20;

// Files stacked from the given tops, each a 32px header followed by 20px lines.
function viewer(tops: Record<string, number>, collapsed: readonly string[] = []) {
  const items = new Map(Object.entries(tops));
  const instance = {
    getHeight: () => 500,
    getTopForItem: (id: string) => items.get(id),
    getRenderedItems: () =>
      [...items.keys()].map((id) => ({
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

describe("createCodeViewScrollRestore", () => {
  it("puts a remounted viewer back on its scope's file and line, not its pixel offset", () => {
    const first = viewer({ a: 0, b: 4000, c: 9000 });
    // 104px into file b: line 7 is the first under the sticky header, 16px below its edge.
    mount("thread-a", first).onScroll(4104, first.instance);
    const other = viewer({ a: 0, b: 4000 });
    mount("thread-b", other).onScroll(1200, other.instance);

    // The remounted viewer estimates file a shorter, so file b starts elsewhere.
    const again = viewer({ a: 0, b: 2500, c: 6000 });
    mount("thread-a", again);
    expect(again.scrolls).toEqual([
      { type: "line", id: "b", align: "start", lineNumber: 7, offset: 16 },
    ]);
  });

  it("loads more files until the anchored file has loaded, then falls back to the file", () => {
    const first = viewer({ a: 0, b: 4000 });
    mount("thread-c", first).onScroll(4104, first.instance);

    const loading = viewer({ a: 0 });
    let batches = 0;
    const restore = mount("thread-c", loading, false, () => {
      batches += 1;
    });
    restore.onScroll(0, loading.instance);
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
    const first = viewer({ a: 0, b: 4000 });
    const restore = mount("thread-d", first);
    restore.onScroll(4104, first.instance);
    restore.discard();

    const again = viewer({ a: 0, b: 4000 });
    mount("thread-d", again);
    expect(again.scrolls).toEqual([]);
  });
});
