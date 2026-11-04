// @effect-diagnostics nodeBuiltinImport:off - reads the installed native JS bundle for synchronous VM tests.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

function createList(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const renderState = source.slice(
    source.indexOf("function setInitialRenderState("),
    source.indexOf("// src/core/finishInitialScroll.ts"),
  );
  const watchdog = source.slice(
    source.indexOf("var INSET_END_SETTLE_WATCHDOG_FRAMES"),
    source.indexOf("function dispatchInitialScroll("),
  );
  const initialScroll = source.slice(
    source.indexOf("var PRESERVED_INITIAL_SCROLL_FALLBACK_CLEAR_DELAY_MS"),
    source.indexOf("// src/core/calculateOffsetForIndex.ts"),
  );
  const imperativeHandle = source.slice(
    source.indexOf("function createImperativeHandle("),
    source.indexOf("// src/utils/getAlwaysRenderIndices.ts"),
  );
  const frames: Array<() => void> = [];
  const values = new Map<string, unknown>();
  const scrollTo = vi.fn();
  const onLoad = vi.fn();
  const state = {
    props: { data: ["message"], onLoad, drawDistance: 500 },
    initialScroll: { index: 0, viewPosition: 1 } as
      | { index: number; viewPosition: number }
      | undefined,
    loadStartTime: 0,
    didContainersLayout: true,
    didFinishInitialScroll: true,
    didLoad: false,
    didUserDrag: false,
    insetEndSettleWatchdogActive: false,
    insetEndRevealHold: false,
    scrollLength: 800,
    scroll: 400,
    lastNativeScroll: 200 as number | undefined,
    scrollingTo: undefined as { offset: number } | undefined,
    maintainingScrollAtEnd: false,
    refScroller: { current: { scrollTo } },
    scheduledWork: { cancel: vi.fn(), has: () => false },
  };
  const ctx = { state };
  let contentSize = 1200;
  let inset = 100;
  const api = NodeVM.runInNewContext(
    `${renderState}\n${watchdog}\n${initialScroll}\n${imperativeHandle}\n({ start: startInsetEndSettleWatchdog, complete: setInitialRenderState, finish: finishInitialScroll, list: createImperativeHandle(ctx) })`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      getContentSize: () => contentSize,
      getContentInsetStartAdjustment: () => inset,
      peek$: (_ctx: unknown, key: string) => values.get(key),
      set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
      setAdaptiveRender: vi.fn(),
      scheduleFullDrawDistancePrewarm: vi.fn(),
      INITIAL_DRAW_DISTANCE: 250,
      Platform: { OS: "ios" },
      ctx,
      initialScrollCompletion: { resetFlags: vi.fn() },
      initialScrollWatchdog: { clear: vi.fn() },
      setInitialScrollSession: vi.fn(),
      settlePendingImperativeScroll: vi.fn(),
      scrollToIndex: () => {
        state.scroll = 200;
        state.lastNativeScroll = 200;
        scrollTo({ animated: false, x: 0, y: 200 });
      },
    },
  ) as {
    start: (context: typeof ctx) => void;
    complete: (context: typeof ctx, flags: Record<string, boolean>) => void;
    finish: (context: typeof ctx) => void;
    list: { scrollToIndex: (params: { index: number }) => Promise<void> };
  };
  return {
    state,
    scrollTo,
    onLoad,
    start: () => api.start(ctx),
    complete: () => api.complete(ctx, {}),
    finish: () => api.finish(ctx),
    scrollToMessage: () => api.list.scrollToIndex({ index: 0 }),
    ready: () => values.get("readyToRender") === true,
    resize: (size: number) => {
      contentSize = size;
    },
    setInset: (value: number) => {
      inset = value;
    },
    advance(count: number) {
      for (let index = 0; index < count; index++) {
        const batch = frames.splice(0);
        for (const frame of batch) frame();
      }
    },
  };
}

describe.each(["react-native.js", "react-native.mjs"])(
  "initial inset end reveal (%s)",
  (bundle) => {
    it("waits for the native offset instead of the optimistic scroll target", () => {
      const list = createList(bundle);
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).toHaveBeenCalledWith({ animated: false, x: 0, y: 400 });
      list.state.lastNativeScroll = 400;
      list.advance(7);
      expect(list.ready()).toBe(true);
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });

    it("does not count an in-flight scroll as stability", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = 400;
      list.state.scrollingTo = { offset: 400 };
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.scrollingTo = undefined;
      list.state.maintainingScrollAtEnd = true;
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.maintainingScrollAtEnd = false;
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("waits for a stable end target even when native scrolling follows each measurement", () => {
      const list = createList(bundle);
      list.start();
      for (let index = 0; index < 10; index++) {
        list.resize(1200 + index * 10);
        list.state.lastNativeScroll = 400 + index * 10;
        list.advance(1);
      }
      expect(list.ready()).toBe(false);
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("keeps the reveal bounded when native events never arrive", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = undefined;
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.advance(32);
      expect(list.ready()).toBe(true);
    });

    it("releases control on drag and never starts another initial hold", () => {
      const list = createList(bundle);
      list.start();
      list.state.didUserDrag = true;
      list.advance(1);
      expect(list.ready()).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.complete();
      list.start();
      list.advance(20);
      expect(list.state.didUserDrag).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });

    it.each(["before reveal", "after reveal", "after clearing the initial target"])(
      "keeps an imperative message position %s",
      async (phase) => {
        const list = createList(bundle);
        list.state.lastNativeScroll = 400;
        list.start();
        if (phase !== "before reveal") list.advance(7);
        expect(list.ready()).toBe(phase !== "before reveal");
        if (phase === "after clearing the initial target") {
          list.finish();
          expect(list.state.initialScroll).toBeUndefined();
        }

        const scroll = list.scrollToMessage();
        expect(list.state.insetEndSettleWatchdogActive).toBe(false);
        expect(list.state.insetEndRevealHold).toBe(false);
        expect(list.ready()).toBe(true);
        await scroll;
        list.advance(150);

        expect(list.ready()).toBe(true);
        expect(list.onLoad).toHaveBeenCalledTimes(1);
        expect(list.scrollTo.mock.calls).toEqual([[{ animated: false, x: 0, y: 200 }]]);
      },
    );

    it("keeps a message position requested by onLoad when the reveal budget expires", () => {
      const list = createList(bundle);
      list.onLoad.mockImplementation(() => void list.scrollToMessage());
      list.state.lastNativeScroll = undefined;
      list.start();
      list.advance(150);

      expect(list.ready()).toBe(true);
      expect(list.onLoad).toHaveBeenCalledTimes(1);
      expect(list.scrollTo.mock.calls).toEqual([[{ animated: false, x: 0, y: 200 }]]);
    });
  },
);
