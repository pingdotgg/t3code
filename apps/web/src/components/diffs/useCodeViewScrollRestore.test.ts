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
  loaded = 0,
) {
  const restore = createCodeViewScrollRestore();
  restore.update(scopeKey, settled, loadMore, loaded);
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
    // Past the end, Pierre clamps the target to the bottom without subtracting the header.
    expect(shrunk.scrolls).toEqual([{ type: "position", position: 1532 }]);

    // The viewer's own end can lie past the files (a footer), so the last 32px is left to it.
    const nearEnd = viewer(2000);
    mount("thread-near-end", nearEnd).onScroll(1476, nearEnd.instance);
    const nearEndAgain = viewer(2000);
    mount("thread-near-end", nearEndAgain);
    expect(nearEndAgain.scrolls).toEqual([{ type: "position", position: 1508 }]);
  });

  it("waits for as many batches as were shown when the position was saved", () => {
    const first = viewer(10_000);
    mount("pull-request-a", first, true, null, 2).onScroll(300, first.instance);

    // The first batch alone is tall enough, but the second sorts files above it.
    const again = viewer(10_000);
    let batches = 0;
    const loadMore = () => {
      batches += 1;
    };
    const restore = mount("pull-request-a", again, false, loadMore, 1);
    expect(again.scrolls).toEqual([]);
    expect(batches).toBe(1);
    restore.update("pull-request-a", false, loadMore, 2);
    restore.flush();
    expect(again.scrolls).toEqual([{ type: "position", position: 332 }]);
  });

  it("holds a position, even one saved meanwhile, until the caller's layout is ready", () => {
    const first = viewer(10_000);
    const early = createCodeViewScrollRestore();
    early.update("pull-request-b", true, null, 1, false);
    early.attach(first);
    early.onScroll(400, first.instance);

    const again = viewer(10_000);
    const restore = createCodeViewScrollRestore();
    restore.update("pull-request-b", true, null, 1, false);
    restore.attach(again);
    restore.flush();
    expect(again.scrolls).toEqual([]);
    restore.update("pull-request-b", true, null, 1, true);
    restore.flush();
    expect(again.scrolls).toEqual([{ type: "position", position: 432 }]);
  });

  it("lets a reader who scrolls while more files load keep their own position", () => {
    const first = viewer(10_000);
    mount("thread-e", first).onScroll(4000, first.instance);

    const loading = viewer(700);
    const restore = mount("thread-e", loading, false, () => {});
    // Unreached until a scroll replaces it: a click that cut the restore short scrolls nothing.
    expect(restore.cancel()).toBe(true);
    expect(restore.cancel()).toBe(true);
    expect(createCodeViewScrollRestore().cancel()).toBe(true);
    restore.onScroll(150, loading.instance);
    expect(restore.cancel()).toBe(false);
    loading.instance.scrollHeight = 10_000;
    restore.update("thread-e", true, null);
    restore.flush();
    expect(loading.scrolls).toEqual([]);

    const again = viewer(10_000);
    mount("thread-e", again);
    expect(again.scrolls).toEqual([{ type: "position", position: 182 }]);
  });

  it("moves a viewer kept across a scope change to that scope's position, not the old one", () => {
    const commitA = viewer(10_000);
    mount("commit-a", commitA).onScroll(3000, commitA.instance);
    const commitB = viewer(10_000);
    mount("commit-b", commitB).onScroll(800, commitB.instance);

    const kept = viewer(700);
    const restore = mount("commit-a", kept, false, () => {});
    restore.update("commit-b", true, null);
    kept.instance.scrollHeight = 10_000;
    restore.flush();
    expect(kept.scrolls).toEqual([{ type: "position", position: 832 }]);
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
