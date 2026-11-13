import type { CodeViewScrollTarget } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { createCodeViewScrollRestore } from "./useCodeViewScrollRestore";

function viewer(scrollHeight: number, height = 500) {
  const instance = { scrollHeight, height, getHeight: () => 0, getScrollHeight: () => 0 };
  instance.getHeight = () => instance.height;
  instance.getScrollHeight = () => instance.scrollHeight;
  const scrolls: CodeViewScrollTarget[] = [];
  return {
    instance,
    scrolls,
    getInstance: () => instance,
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
  it("puts a remounted viewer back at its scope's position, not another scope's", () => {
    const first = viewer(10_000);
    mount("thread-a", first).onScroll(4000, first.instance);
    const other = viewer(10_000);
    mount("thread-b", other).onScroll(1200, other.instance);

    const again = viewer(10_000);
    mount("thread-a", again);
    // Pierre subtracts the 32px sticky header from an unclamped position target.
    expect(again.scrolls).toEqual([{ type: "position", position: 4032 }]);
  });

  it("loads more files until the position is reachable, then gives up once none remain", () => {
    const first = viewer(10_000);
    mount("thread-c", first).onScroll(4000, first.instance);

    const loading = viewer(700);
    let batches = 0;
    const restore = mount("thread-c", loading, false, () => {
      batches += 1;
    });
    restore.onScroll(0, loading.instance);
    restore.flush();
    expect(loading.scrolls).toEqual([]);
    expect(batches).toBe(2);
    loading.instance.scrollHeight = 10_000;
    restore.flush();
    restore.flush();
    expect(loading.scrolls).toEqual([{ type: "position", position: 4032 }]);

    const shrunk = viewer(2000);
    const settling = mount("thread-c", shrunk, false);
    settling.flush();
    expect(shrunk.scrolls).toEqual([]);
    settling.update("thread-c", true, null);
    settling.flush();
    expect(shrunk.scrolls).toEqual([{ type: "position", position: 1500 }]);
  });

  it("forgets a position that a reveal or collapsing every file replaced", () => {
    const first = viewer(10_000);
    const restore = mount("thread-d", first);
    restore.onScroll(4000, first.instance);
    restore.discard();

    const again = viewer(10_000);
    mount("thread-d", again);
    expect(again.scrolls).toEqual([]);
  });
});
