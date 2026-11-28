import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import {
  THREAD_FEED_MAINTAIN_SCROLL_AT_END,
  THREAD_FEED_MAINTAIN_SCROLL_AT_END_THRESHOLD,
} from "./threadFeedEndFollow";

const require = NodeModule.createRequire(import.meta.url);

interface ListInternals {
  readonly checkAtBottom: (ctx: unknown) => void;
  readonly settleUserScroll: (ctx: unknown) => void;
}

// The end checks are internal to the patched bundle; expose them from the native build as seen on iOS.
function loadPatchedListInternals(): ListInternals {
  const webBundlePath = require.resolve("@legendapp/list/react-native");
  const bundlePath = NodePath.join(NodePath.dirname(webBundlePath), "react-native.js");
  const source = `${NodeFS.readFileSync(bundlePath, "utf8")}\nmodule.exports.internals = { checkAtBottom, settleUserScroll };`;
  const inert: object = new Proxy(function () {}, {
    get: (_target, key) => (key === Symbol.toPrimitive ? () => "" : inert),
    apply: () => inert,
    construct: () => inert,
  });
  const withInertFallback = (target: object) =>
    new Proxy(target, {
      get: (object, key) => (key in object ? Reflect.get(object, key) : inert),
    });
  const reactNative = withInertFallback({ Platform: withInertFallback({ OS: "ios" }) });
  const module = { exports: {} as { internals?: ListInternals } };
  NodeVM.compileFunction(source, ["exports", "require", "module"], { filename: bundlePath })(
    module.exports,
    (id: string) => (id === "react-native" ? reactNative : inert),
    module,
  );
  const internals = module.exports.internals;
  if (!internals) throw new Error(`list internals not found in ${bundlePath}`);
  return internals;
}

const { checkAtBottom, settleUserScroll } = loadPatchedListInternals();

// iPhone 17 Pro thread feed: header inset 116, composer inset 142.5, rows 693.29,
// so the end rests at -38.21 and the start at -116.
const scrollLength = 874;
const insetTop = 116;
const insetBottom = 142.5;
const contentSize = 835.79;

function createFeedList(scroll: number, rowsLength = contentSize - insetBottom) {
  const values = new Map<string, unknown>([["totalSize", rowsLength]]);
  const ctx = {
    values,
    listeners: new Map(),
    scrollAxisGap: 0,
    state: {
      queuedInitialLayout: true,
      didFinishInitialScroll: true,
      scroll,
      scrollLength,
      scheduledWork: { cancel: () => {}, has: () => false },
      props: {
        data: [{}],
        contentInset: { top: insetTop, bottom: insetBottom },
        maintainScrollAtEnd: THREAD_FEED_MAINTAIN_SCROLL_AT_END,
        maintainScrollAtEndThreshold: THREAD_FEED_MAINTAIN_SCROLL_AT_END_THRESHOLD,
        onEndReachedThreshold: 0.5,
      },
    },
  };
  return { ctx, values };
}

function isAtEnd(scroll: number, rowsLength?: number) {
  const { ctx, values } = createFeedList(scroll, rowsLength);
  checkAtBottom(ctx);
  return values.get("isAtEnd");
}

describe("patched LegendList end detection in the thread feed", () => {
  it("does not report the start edge as the end when content overflows below the header inset", () => {
    expect(isAtEnd(contentSize - scrollLength)).toBe(true);
    expect(isAtEnd(-insetTop, 758 - insetBottom), "content that exactly fits").toBe(true);

    expect(
      isAtEnd(-insetTop),
      "a feed pulled to its start edge (scroll -116) is 77.8pt from its end",
    ).toBe(false);
    expect(isAtEnd(-114), "a feed just below its start edge is 75.8pt from its end").toBe(false);
  });

  it("does not re-arm end following when a pull to the start edge is released", () => {
    const { ctx, values } = createFeedList(-insetTop);
    checkAtBottom(ctx);
    Object.assign(ctx.state, { userScrollContentSize: contentSize });
    settleUserScroll(ctx);
    checkAtBottom(ctx);

    expect(values.get("isFollowingEnd")).toBe(false);
    expect(values.get("isWithinMaintainScrollAtEndThreshold")).toBe(false);
  });
});
