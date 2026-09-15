// @effect-diagnostics nodeBuiltinImport:off - exercises the installed native bundle without React Native.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  resolveThreadFeedLiveFollow,
  shouldShowThreadFeedScrollToEnd,
} from "./thread-feed-live-follow";

function createList(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../../../node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const slice = (start: string, end: string) =>
    source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const state = { queuedInitialLayout: true, scroll: 400, scrollLength: 800 };
  const ctx = {
    state,
    values: new Map<string, boolean>([["isAtEnd", true]]),
    listeners: new Map<string, Set<(value: boolean) => void>>(),
  };
  let contentSize = 1200;
  const maintainScrollAtEnd = vi.fn();
  const api = NodeVM.runInNewContext(
    [
      slice("function listen$(", "function listenPosition$("),
      slice("function getIsAtEnd(", "// src/utils/checkAtBottom.ts"),
      slice("function flushItemSizeUpdates(", "function updateItemSizes("),
      "({ listen$, getIsAtEnd, flushItemSizeUpdates })",
    ].join("\n"),
    {
      getContentSize: () => contentSize,
      getContentInsetEnd: () => 0,
      EDGE_POSITION_EPSILON: 1,
      maybeUpdateAnchoredEndSpace: vi.fn(),
      doMaintainScrollAtEnd: maintainScrollAtEnd,
    },
  ) as {
    listen$: (context: typeof ctx, key: string, callback: (value: boolean) => void) => () => void;
    getIsAtEnd: (context: typeof ctx) => boolean;
    flushItemSizeUpdates: (
      context: typeof ctx,
      result: { didChange: boolean; shouldMaintainScrollAtEnd: boolean },
    ) => void;
  };
  return {
    state,
    maintainScrollAtEnd,
    isAtEnd: () => api.getIsAtEnd(ctx),
    listen: (callback: (value: boolean) => void) => api.listen$(ctx, "isAtEnd", callback),
    resize(size: number, follow = false) {
      const didChange = contentSize !== size;
      contentSize = size;
      api.flushItemSizeUpdates(ctx, { didChange, shouldMaintainScrollAtEnd: follow });
    },
  };
}

for (const bundle of ["react-native.js", "react-native.mjs"]) {
  describe(`end position after row layout (${bundle})`, () => {
    it("shows the button after expanding a work row without scrolling and hides it on collapse", () => {
      const list = createList(bundle);
      let isAtEnd = list.isAtEnd();
      list.listen((value) => {
        isAtEnd = value;
      });
      list.resize(1600);
      const endFollowEnabled = resolveThreadFeedLiveFollow(true, {
        type: "disclosure-settled",
        isAtEnd: list.isAtEnd(),
        userScrollSessionActive: false,
      });
      expect(endFollowEnabled).toBe(false);
      expect(shouldShowThreadFeedScrollToEnd({ endFollowEnabled, isAtEnd })).toBe(true);
      expect(list.state.scroll).toBe(400);
      expect(list.maintainScrollAtEnd).not.toHaveBeenCalled();

      list.resize(1200);
      expect(shouldShowThreadFeedScrollToEnd({ endFollowEnabled, isAtEnd })).toBe(false);
    });

    it("reports only edge transitions and unsubscribes", () => {
      const list = createList(bundle);
      const changed = vi.fn();
      const unsubscribe = list.listen(changed);
      list.resize(1600);
      list.resize(1800);
      list.resize(1800);
      list.resize(1200);
      expect(changed.mock.calls).toEqual([[false], [true]]);
      unsubscribe();
      list.resize(1600);
      expect(changed).toHaveBeenCalledTimes(2);
    });

    it("keeps overscroll at the end and preserves requested live-follow", () => {
      const list = createList(bundle);
      list.state.scroll = 600;
      const changed = vi.fn();
      list.listen(changed);
      list.resize(1300, true);
      expect(list.isAtEnd()).toBe(true);
      expect(changed).not.toHaveBeenCalled();
      expect(list.maintainScrollAtEnd).toHaveBeenCalledTimes(1);
    });
  });
}
