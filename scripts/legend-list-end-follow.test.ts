// @effect-diagnostics nodeBuiltinImport:off - exercises the installed native patch in a VM.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

function createList(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const follow = source.slice(
    source.indexOf("function doMaintainScrollAtEnd("),
    source.indexOf("// src/utils/requestAdjust.ts"),
  );
  const flush = source.slice(
    source.indexOf("function flushItemSizeUpdates("),
    source.indexOf("function updateItemSizes("),
  );
  const frames: Array<() => void> = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const scrollTo = vi.fn();
  const sizes: Array<number | undefined> = [800, undefined];
  const state = {
    props: {
      data: ["answer", "commentary"],
      maintainScrollAtEnd: { animated: false } as false | { animated: boolean },
    },
    didContainersLayout: true,
    startBuffered: 0,
    endBuffered: 1,
    scroll: 100,
    scrollLength: 800,
    pendingMaintainScrollAtEnd: false,
    maintainingScrollAtEnd: undefined,
    refScroller: { current: { scrollTo } },
  };
  let withinThreshold = true;
  const ctx = { state };
  const api = NodeVM.runInNewContext(
    `${follow}\n${flush}\n({ follow: doMaintainScrollAtEnd, flush: flushItemSizeUpdates })`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      setTimeout: (callback: () => void, delay: number) => timers.push({ callback, delay }),
      peek$: () => withinThreshold,
      getContentSize: () => sizes.reduce<number>((sum, size) => sum + (size ?? 600), 100),
      getContentInsetStartAdjustment: () => 100,
      areKnownOrFixedItemSizesAvailable: (_ctx: unknown, start: number, end: number) =>
        sizes.slice(start, end + 1).every((size) => size !== undefined),
      maybeUpdateAnchoredEndSpace: vi.fn(),
    },
  ) as {
    follow: (context: typeof ctx) => boolean;
    flush: (
      context: typeof ctx,
      result: { didChange: boolean; shouldMaintainScrollAtEnd?: boolean },
    ) => void;
  };
  return {
    state,
    sizes,
    scrollTo,
    follow: () => api.follow(ctx),
    measure: (size: number, didChange = true) => {
      sizes[1] = size;
      api.flush(ctx, { didChange, shouldMaintainScrollAtEnd: didChange });
    },
    leaveEnd: () => {
      withinThreshold = false;
    },
    advanceTimers: (elapsed: number) => {
      for (const timer of timers.splice(0)) {
        if (timer.delay <= elapsed) timer.callback();
        else timers.push({ ...timer, delay: timer.delay - elapsed });
      }
    },
    frame: () => {
      for (const callback of frames.splice(0)) callback();
    },
  };
}

for (const bundle of ["react-native.js", "react-native.mjs"]) {
  describe(`measured end follow (${bundle})`, () => {
    it("preserves row height when synchronous native measurement is temporarily zero", () => {
      const source = NodeFS.readFileSync(
        new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
        "utf8",
      );
      const measureSource = source.slice(
        source.indexOf("function measureContainersInLayoutEffect("),
        source.indexOf("var typedForwardRef ="),
      );
      let rectangle = { width: 0, height: 0 };
      const update = vi.fn();
      const ctx = {
        state: {
          props: { horizontal: false },
          containerItemGenerations: [0],
          sizesKnown: new Map([["answer", 1400]]),
        },
        viewRefs: new Map([
          [
            0,
            {
              current: {
                measure: (callback: (...args: number[]) => void) =>
                  callback(0, 0, rectangle.width, rectangle.height),
              },
            },
          ],
        ]),
      };
      const measure = NodeVM.runInNewContext(`${measureSource}\nmeasureContainersInLayoutEffect`, {
        peek$: () => "answer",
        resolveFixedItemSize: () => undefined,
        updateItemSizesBatch: update,
        updateItemSizes: vi.fn(),
      }) as (context: typeof ctx) => void;
      measure(ctx);
      expect(update).not.toHaveBeenCalled();
      expect(ctx.state.sizesKnown.get("answer")).toBe(1400);
      rectangle = { width: 400, height: 1453 };
      measure(ctx);
      expect(update).toHaveBeenLastCalledWith(ctx, [
        { containerId: 0, itemKey: "answer", size: rectangle },
      ]);
      rectangle = { width: 400, height: 0 };
      measure(ctx);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
      "preserves the answer across a work fold (earlier message visible: %s)",
      (earlierMessageVisible) => {
        const source = NodeFS.readFileSync(
          new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
          "utf8",
        );
        const prepareSource = source.slice(
          source.indexOf("function prepareMVCP("),
          source.indexOf("// src/platform/flushSync.native.ts"),
        );
        const queueSource = source.slice(
          source.indexOf("function shouldQueueNativeMVCPAdjust("),
          source.indexOf("function getPredictedNativeClamp("),
        );
        const visible = earlierMessageVisible ? ["older-user", "answer"] : ["answer"];
        const state = {
          props: {
            data: visible,
            maintainVisibleContentPosition: {
              data: true,
              size: false,
              shouldRestorePosition: (row: string) => row === "answer",
            },
          },
          idsInView: visible,
          positions: earlierMessageVisible ? [100, 500] : [500],
          indexByKey: new Map(visible.map((id, index) => [id, index])),
          scroll: 700,
          scrollLength: 800,
          didContainersLayout: true,
          maintainingScrollAtEnd: "pending-animated",
        };
        const adjust = vi.fn();
        const prepare = NodeVM.runInNewContext(`${queueSource}\n${prepareSource}\nprepareMVCP`, {
          Platform: { OS: "ios" },
          getContentSize: () => 2000,
          peek$: () => true,
          updateAnchorLock: vi.fn(),
          requestAdjust: adjust,
          MVCP_POSITION_EPSILON: 0.1,
        }) as (ctx: { state: typeof state }, changed: boolean) => () => void;
        const ctx = { state };
        const commit = prepare(ctx, true);
        state.positions[state.indexByKey.get("answer")!]! -= 137.5;
        commit();
        expect(adjust).toHaveBeenCalledExactlyOnceWith(ctx, -137.5, true);
      },
    );

    it("waits for a short row instead of scrolling to its large estimate", () => {
      const list = createList(bundle);
      expect(list.follow()).toBe(true);
      list.frame();
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.measure(22);
      list.frame();
      expect(list.scrollTo).toHaveBeenCalledExactlyOnceWith({ animated: false, x: 0, y: 122 });
    });
    it("retries even when the measured size equals the estimate", () => {
      const list = createList(bundle);
      list.follow();
      list.measure(600, false);
      list.frame();
      expect(list.scrollTo).toHaveBeenCalledExactlyOnceWith({ animated: false, x: 0, y: 700 });
    });
    it("rechecks rows added before the scheduled native scroll", () => {
      const list = createList(bundle);
      list.sizes[1] = 22;
      list.follow();
      list.sizes[1] = undefined;
      list.frame();
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.measure(44);
      list.frame();
      expect(list.scrollTo).toHaveBeenCalledExactlyOnceWith({ animated: false, x: 0, y: 144 });
    });
    it("does not wait for rows outside the render buffer", () => {
      const list = createList(bundle);
      list.state.endBuffered = 0;
      list.follow();
      list.frame();
      expect(list.scrollTo).toHaveBeenCalledOnce();
    });
    it("does not reclaim the viewport after the reader scrolls away", () => {
      const list = createList(bundle);
      list.follow();
      list.leaveEnd();
      list.measure(22);
      list.frame();
      expect(list.scrollTo).not.toHaveBeenCalled();
    });
    it("retargets native animation on the next measurement without a 500ms queue", () => {
      const list = createList(bundle);
      list.state.props.maintainScrollAtEnd = { animated: true };
      list.measure(22);
      list.frame();
      list.advanceTimers(16);
      list.measure(140);
      list.frame();
      expect(list.scrollTo.mock.calls).toEqual([
        [{ animated: true, x: 0, y: 122 }],
        [{ animated: true, x: 0, y: 240 }],
      ]);
    });
    it("cancels a queued scroll when follow is disabled", () => {
      const list = createList(bundle);
      list.sizes[1] = 22;
      list.follow();
      list.state.props.maintainScrollAtEnd = false;
      list.frame();
      expect(list.scrollTo).not.toHaveBeenCalled();
    });
  });
}
