// @effect-diagnostics nodeBuiltinImport:off - reads the installed native JS bundle for synchronous VM tests.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

function readBundle(bundle: string) {
  return NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
}

function extractFunctions(source: string, names: ReadonlyArray<string>) {
  return names
    .map((name) => {
      const start = source.indexOf(`\nfunction ${name}(`);
      return source.slice(start, source.indexOf("\n}\n", start) + 3);
    })
    .join("");
}

function createList(bundle: string) {
  const source = readBundle(bundle);
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

// Measured on an iPhone 12 thread whose rows fit the full viewport but not the area below
// the Liquid Glass header (top) and the composer (bottom).
const glassFeed = {
  scrollLength: 844,
  insetStart: 101,
  insetBottom: 60,
  insetEndAdjustment: 34,
  headerSize: 52.666664,
  paddingTop: 12,
  rows: 654.5,
};
const glassFeedEnd = 52.666664 + 12 + 654.5 + 94 - 844;
// Opaque header: only the composer covers the feed.
const composerFeed = {
  scrollLength: 800,
  insetStart: 0,
  insetBottom: 200,
  insetEndAdjustment: 0,
  headerSize: 0,
  paddingTop: 0,
  rows: 700,
};
const shortGlassFeed = { ...glassFeed, rows: 500 };
const plainFeed = { ...composerFeed, insetBottom: 0, rows: 1000 };

function createEdgeList(bundle: string, feed: typeof glassFeed, scroll: number) {
  const source = readBundle(bundle);
  const epsilon = source.match(/\nvar EDGE_POSITION_EPSILON = [^;]+;/)?.[0] ?? "";
  const frames: Array<() => void> = [];
  const values = new Map<string, unknown>([
    ["headerSize", feed.headerSize],
    ["stylePaddingTop", feed.paddingTop],
    ["isWithinMaintainScrollAtEndThreshold", true],
  ]);
  const scrollTo = vi.fn();
  const state = {
    props: {
      data: ["a", "b", "c"],
      contentInset: { bottom: feed.insetBottom },
      contentInsetEndAdjustment: feed.insetEndAdjustment,
      contentInsetStartAdjustment: feed.insetStart,
      maintainScrollAtEnd: { animated: false },
    },
    queuedInitialLayout: true,
    didContainersLayout: true,
    totalSize: feed.rows,
    scroll,
    scrollLength: feed.scrollLength,
    refScroller: { current: { scrollTo } },
  };
  const ctx = { state, values, scrollAxisGap: 0 };
  const functions = extractFunctions(source, [
    "getContentInsetEndAdjustmentEnd",
    "getContentInsetEnd",
    "getContentSize",
    "getContentInsetStartAdjustment",
    "getIsAtEnd",
    "doMaintainScrollAtEnd",
  ]);
  const api = NodeVM.runInNewContext(
    `${epsilon}\n${functions}\n({ getIsAtEnd, doMaintainScrollAtEnd })`,
    {
      peek$: (_ctx: unknown, key: string) => values.get(key),
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      setTimeout: vi.fn(),
    },
  ) as {
    getIsAtEnd: (context: typeof ctx) => boolean;
    doMaintainScrollAtEnd: (context: typeof ctx) => boolean;
  };
  return {
    state,
    scrollTo,
    isAtEnd: () => api.getIsAtEnd(ctx),
    maintainScrollAtEnd: () => {
      api.doMaintainScrollAtEnd(ctx);
      for (const frame of frames.splice(0)) frame();
    },
  };
}

describe.each(["react-native.js", "react-native.mjs"])(
  "end edge with covered bands (%s)",
  (bundle) => {
    it.each([
      { name: "glass header at the top", feed: glassFeed, scroll: -101, atEnd: false },
      { name: "glass header pulled past the top", feed: glassFeed, scroll: -150, atEnd: false },
      { name: "glass header resting at the end", feed: glassFeed, scroll: -31, atEnd: true },
      { name: "composer only at the top", feed: composerFeed, scroll: 0, atEnd: false },
      { name: "composer only at the end", feed: composerFeed, scroll: 100, atEnd: true },
      { name: "content that fits, pulled down", feed: shortGlassFeed, scroll: -150, atEnd: true },
      { name: "no insets at the top", feed: plainFeed, scroll: 0, atEnd: false },
      { name: "no insets at the end", feed: plainFeed, scroll: 200, atEnd: true },
    ])("isAtEnd is $atEnd for $name", ({ feed, scroll, atEnd }) => {
      expect(createEdgeList(bundle, feed, scroll).isAtEnd()).toBe(atEnd);
    });

    it("keeps a followed feed at its scrollable end instead of the start", () => {
      const list = createEdgeList(bundle, glassFeed, -31);
      list.maintainScrollAtEnd();
      expect(list.state.scroll).toBe(-31);
      expect(list.scrollTo).toHaveBeenCalledWith({ animated: false, x: 0, y: glassFeedEnd });
    });
  },
);
