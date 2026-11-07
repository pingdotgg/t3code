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
  const frames: Array<() => void> = [];
  const values = new Map<string, unknown>();
  const scrollTo = vi.fn();
  const onLoad = vi.fn();
  const state = {
    props: { data: ["message"], onLoad, drawDistance: 500 },
    initialScroll: { index: 0, viewPosition: 1 },
    loadStartTime: 0,
    didContainersLayout: true,
    didFinishInitialScroll: true,
    didLoad: false,
    didUserDrag: false,
    scrollLength: 800,
    scroll: 400,
    lastNativeScroll: 200 as number | undefined,
    scrollingTo: undefined as { offset: number } | undefined,
    maintainingScrollAtEnd: false,
    refScroller: { current: { scrollTo } },
  };
  const ctx = { state };
  let contentSize = 1200;
  let inset = 100;
  const api = NodeVM.runInNewContext(
    `${renderState}\n${watchdog}\n({ start: startInsetEndSettleWatchdog, complete: setInitialRenderState })`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      getContentSize: () => contentSize,
      getContentInsetStartAdjustment: () => inset,
      peek$: (_ctx: unknown, key: string) => values.get(key),
      set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
      setAdaptiveRender: vi.fn(),
      scheduleFullDrawDistancePrewarm: vi.fn(),
      INITIAL_DRAW_DISTANCE: 250,
    },
  ) as {
    start: (context: typeof ctx) => void;
    complete: (context: typeof ctx, flags: Record<string, boolean>) => void;
  };
  return {
    state,
    scrollTo,
    onLoad,
    start: () => api.start(ctx),
    complete: () => api.complete(ctx, {}),
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

    it("re-aims a far measured end while hidden, but not after the reveal", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = 400;
      list.resize(2000);
      list.start();
      list.advance(2);
      expect(list.scrollTo).toHaveBeenCalledWith({ animated: false, x: 0, y: 1200 });
      expect(list.ready()).toBe(false);
      list.state.lastNativeScroll = 1200;
      list.advance(7);
      expect(list.ready()).toBe(true);
      list.scrollTo.mockClear();
      list.resize(2800);
      list.advance(4);
      expect(list.scrollTo).not.toHaveBeenCalled();
    });

    it("never chases the list end far from a bottom-aligned row above the last", () => {
      const list = createList(bundle);
      list.state.props.data = ["message", "reply"];
      list.state.lastNativeScroll = 400;
      list.resize(2000);
      list.start();
      list.advance(4);
      expect(list.scrollTo).not.toHaveBeenCalled();
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
  },
);

function createBootstrapEvaluation(bundle: string, lastNativeScroll: number) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const evaluate = source.slice(
    source.indexOf("function evaluateBootstrapInitialScroll("),
    source.indexOf("function finishBootstrapInitialScrollWithoutScroll("),
  );
  const finishWithoutScroll = vi.fn();
  const dispatchInitialScroll = vi.fn();
  // A session re-armed by a data change after landing keeps its stale mount seed.
  const bootstrap = {
    scroll: 4692,
    seedContentOffset: 12,
    previousResolvedOffset: 4692,
    visibleIndices: [9],
    passCount: 0,
    mountFrameCount: 0,
  };
  const state = {
    initialScroll: { index: 9, viewPosition: 1 },
    initialScrollSession: { kind: "bootstrap", bootstrap },
    lastNativeScroll,
    props: { data: [] },
    startBuffered: 9,
    endBuffered: 9,
    idCache: { 9: "message-9" },
    sizesKnown: new Set(["message-9"]),
  };
  const run = NodeVM.runInNewContext(`${evaluate}\nevaluateBootstrapInitialScroll`, {
    getBootstrapInitialScrollSession: () => bootstrap,
    isOffsetInitialScrollSession: () => false,
    abortBootstrapRevealIfNeeded: () => false,
    resolveInitialScrollOffset: () => 4692,
    checkAllSizesKnown: () => true,
    getBootstrapRevealVisibleIndices: () => [9],
    doVisibleIndicesMatch: () => true,
    DEFAULT_BOOTSTRAP_REVEAL_EPSILON: 1,
    Platform: { OS: "ios" },
    getObservedBootstrapInitialScrollOffset: () => lastNativeScroll,
    finishBootstrapInitialScrollWithoutScroll: finishWithoutScroll,
    clearBootstrapInitialScrollSession: vi.fn(),
    dispatchInitialScroll,
    queueBootstrapInitialScrollReevaluation: vi.fn(),
  }) as (context: { state: typeof state }) => void;
  run({ state });
  return { finishWithoutScroll, dispatchInitialScroll };
}

describe.each(["react-native.js", "react-native.mjs"])(
  "re-armed initial end bootstrap (%s)",
  (bundle) => {
    it("finishes without a no-op scroll once native reported the target", () => {
      const landed = createBootstrapEvaluation(bundle, 4692);
      expect(landed.finishWithoutScroll).toHaveBeenCalledTimes(1);
      expect(landed.dispatchInitialScroll).not.toHaveBeenCalled();
      const short = createBootstrapEvaluation(bundle, 4600);
      expect(short.finishWithoutScroll).not.toHaveBeenCalled();
      expect(short.dispatchInitialScroll).toHaveBeenCalledTimes(1);
    });
  },
);

describe.each(["react-native.js", "react-native.mjs"])(
  "in-flight initial scroll re-aim (%s)",
  (bundle) => {
    it("re-aims as rows measure, until the user drags", () => {
      const source = NodeFS.readFileSync(
        new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
        "utf8",
      );
      const flush = source.slice(
        source.indexOf("function flushItemSizeUpdates("),
        source.indexOf("function updateItemSizes("),
      );
      const advanceCurrentInitialScrollSession = vi.fn();
      const run = NodeVM.runInNewContext(`${flush}\nflushItemSizeUpdates`, {
        advanceCurrentInitialScrollSession,
        maybeUpdateAnchoredEndSpace: vi.fn(),
        doMaintainScrollAtEnd: vi.fn(),
      }) as (context: unknown, result: { didChange: boolean }) => void;
      const state = {
        scrollingTo: { isInitialScroll: true },
        initialScrollSession: { kind: "bootstrap" },
        didUserDrag: false,
        props: { maintainVisibleContentPosition: { size: false } },
      };
      run({ state }, { didChange: true });
      expect(advanceCurrentInitialScrollSession).toHaveBeenCalledTimes(1);
      state.didUserDrag = true;
      run({ state }, { didChange: true });
      expect(advanceCurrentInitialScrollSession).toHaveBeenCalledTimes(1);
    });
  },
);
