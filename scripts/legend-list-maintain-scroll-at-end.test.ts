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
  const scrollToEnd = vi.fn();
  const state = {
    props: { maintainScrollAtEnd: { animated: true, onLayout: true, onDataChange: true } },
    didContainersLayout: true,
    pendingNativeMVCPAdjust: undefined,
    refScroller: { current: { scrollToEnd } },
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
      peek$: (_ctx: unknown, key: string) => key === "isWithinMaintainScrollAtEndThreshold",
      set$: vi.fn(),
      getContentSize: () => 3000,
      isHorizontalRTL: () => false,
      updateContentMetricsState: vi.fn(),
      doInitialAllocateContainers: vi.fn(),
      calculateItemsInView: vi.fn(),
      checkThresholds: vi.fn(),
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
    dataChange: () => api.doMaintainScrollAtEnd(ctx),
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
});
