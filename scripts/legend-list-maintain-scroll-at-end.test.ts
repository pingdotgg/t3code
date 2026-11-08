// @effect-diagnostics nodeBuiltinImport:off - reads the installed web JS bundle for synchronous VM tests.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

const FRAME_MS = 16;

function createList(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/web/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const slice = (start: string, end: string) =>
    source.slice(source.indexOf(start), source.indexOf(end));
  const maintain = slice("// src/core/doMaintainScrollAtEnd.ts", "// src/utils/requestAdjust.ts");
  const layout = slice("// src/core/handleLayout.ts", "// src/core/onScroll.ts");
  const frames: Array<() => void> = [];
  let tasks: Array<{ at: number; run: () => void }> = [];
  let now = 0;
  let within = true;
  let layoutLeavesWithinThreshold = true;
  let nativeScroll = 2000;
  const scrollToEnd = vi.fn(() => {
    nativeScroll = 2200;
  });
  const state = {
    props: {
      maintainScrollAtEnd: { animated: true, onLayout: true, onDataChange: true } as
        | { animated: boolean; onLayout: boolean; onDataChange: boolean }
        | undefined,
    },
    didContainersLayout: true,
    pendingNativeMVCPAdjust: undefined,
    refScroller: { current: { scrollToEnd, getCurrentScrollOffset: () => nativeScroll } },
    scroll: 2000,
    scrollLength: 800,
    otherAxisSize: 600,
    lastLayout: { x: 0, y: 0, width: 600, height: 800 },
  };
  const ctx = { state };
  const api = NodeVM.runInNewContext(
    `${maintain}\n${layout}\n({ doMaintainScrollAtEnd, handleLayout })`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      setTimeout: (run: () => void, delay: number) => tasks.push({ at: now + delay, run }),
      peek$: (_ctx: unknown, key: string) =>
        key === "isWithinMaintainScrollAtEndThreshold" && within,
      set$: vi.fn(),
      getContentSize: () => 3000,
      isHorizontalRTL: () => false,
      updateContentMetricsState: vi.fn(),
      doInitialAllocateContainers: vi.fn(),
      calculateItemsInView: vi.fn(),
      checkThresholds: () => {
        within = layoutLeavesWithinThreshold;
      },
      updateScroll: (_ctx: unknown, offset: number) => {
        state.scroll = offset;
      },
      IS_DEV: false,
    },
  ) as {
    doMaintainScrollAtEnd: (context: typeof ctx) => boolean;
    handleLayout: (context: typeof ctx, layout: object, setCanRender: () => void) => void;
  };
  const runDueTasks = () => {
    const due = tasks.filter((task) => task.at <= now);
    tasks = tasks.filter((task) => task.at > now);
    for (const task of due) task.run();
  };
  return {
    scrollToEnd,
    state,
    dataChange: () => api.doMaintainScrollAtEnd(ctx),
    /** The shrink leaves the end further away than the new, smaller viewport. */
    layoutLeavesEndBeyondThreshold() {
      layoutLeavesWithinThreshold = false;
    },
    /** A scroll event moves the list without a pin, such as a smooth scroll in flight. */
    scrolled(offset: number) {
      nativeScroll = offset;
      state.scroll = offset;
    },
    /** The app passes maintainScrollAtEnd={false} once the reader scrolls away. */
    releaseFollow() {
      state.props.maintainScrollAtEnd = undefined;
    },
    /** A pin that lands at the end brings the threshold back. */
    reachEnd() {
      within = true;
      layoutLeavesWithinThreshold = true;
    },
    // Browser order per frame: rAF callbacks, then ResizeObserver layout, then queued tasks.
    frame(viewportHeight?: number) {
      now += FRAME_MS;
      for (const callback of frames.splice(0)) callback();
      if (viewportHeight !== undefined) {
        api.handleLayout(ctx, { x: 0, y: 0, width: 600, height: viewportHeight }, () => {});
      }
      runDueTasks();
    },
  };
}

describe.each(["react.mjs", "react.js"])("maintainScrollAtEnd while animated (%s)", (bundle) => {
  it("pins every frame of a continuous viewport resize instantly", () => {
    const list = createList(bundle);
    for (let index = 1; index <= 12; index++) list.frame(800 - index * 20);
    list.frame();
    expect(list.scrollToEnd.mock.calls).toEqual(
      Array.from({ length: 12 }, () => [{ animated: false }]),
    );
  });

  it("keeps a content-growth pin smooth and pins the following resize instantly", () => {
    const list = createList(bundle);
    list.dataChange();
    for (let index = 1; index <= 6; index++) list.frame(800 - index * 20);
    list.frame();
    expect(list.scrollToEnd.mock.calls).toEqual([
      [{ animated: true }],
      ...Array.from({ length: 6 }, () => [{ animated: false }]),
    ]);
  });

  it("pins a shrink that leaves the end beyond one viewport while a smooth scroll is in flight", () => {
    const list = createList(bundle);
    list.dataChange();
    list.frame();
    list.layoutLeavesEndBeyondThreshold();
    list.frame(468);
    list.scrolled(2030);
    list.frame();
    expect(list.scrollToEnd.mock.calls).toEqual([[{ animated: true }], [{ animated: false }]]);
    // A later MVCP adjustment rebases on this offset, so it must be the pinned one.
    expect(list.state.scroll).toBe(2200);
    list.reachEnd();
    for (let index = 0; index < 32; index++) list.frame();
    list.dataChange();
    list.frame();
    expect(list.scrollToEnd.mock.calls.at(-1)).toEqual([{ animated: true }]);
  });

  it("drops a queued resize pin once the reader scrolls away", () => {
    const list = createList(bundle);
    list.frame(700);
    list.releaseFollow();
    list.frame();
    expect(list.scrollToEnd).not.toHaveBeenCalled();
  });
});
