import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { describe, expect, it } from "vite-plus/test";

interface ListGeometry {
  readonly scroll: number;
  readonly scrollLength: number;
  readonly contentLength: number;
  readonly insetStart: number;
  readonly insetEnd: number;
}

const require = NodeModule.createRequire(import.meta.url);

// getIsAtEnd is internal to the patched bundle; expose it from the native (react-native condition) build.
function loadPatchedGetIsAtEnd() {
  const webBundlePath = require.resolve("@legendapp/list/react-native");
  const bundlePath = NodePath.join(NodePath.dirname(webBundlePath), "react-native.js");
  const source = `${NodeFS.readFileSync(bundlePath, "utf8")}\nmodule.exports.getIsAtEnd = getIsAtEnd;`;
  const inert: object = new Proxy(function () {}, {
    get: (_target, key) => (key === Symbol.toPrimitive ? () => "" : inert),
    apply: () => inert,
    construct: () => inert,
  });
  const module = { exports: {} as { getIsAtEnd?: (ctx: unknown) => boolean } };
  NodeVM.compileFunction(source, ["exports", "require", "module"], { filename: bundlePath })(
    module.exports,
    () => inert,
    module,
  );
  const getIsAtEnd = module.exports.getIsAtEnd;
  if (!getIsAtEnd) throw new Error(`getIsAtEnd not found in ${bundlePath}`);
  return getIsAtEnd;
}

const getIsAtEnd = loadPatchedGetIsAtEnd();

function isAtEnd(geometry: ListGeometry) {
  return getIsAtEnd({
    values: new Map<string, unknown>([["totalSize", geometry.contentLength]]),
    scrollAxisGap: 0,
    state: {
      queuedInitialLayout: true,
      scroll: geometry.scroll,
      scrollLength: geometry.scrollLength,
      props: {
        data: [{}],
        contentInset: { bottom: geometry.insetEnd },
        contentInsetStartAdjustment: geometry.insetStart,
      },
    },
  });
}

// iPhone 17 Pro thread feed: header inset 116, composer inset 142.5,
// content (including the composer inset) 835.79, so the end rests at -38.21 and the start at -116.
const scrollLength = 874;
const insetStart = 116;
const insetEnd = 142.5;
const contentSize = 835.79;
const deviceGeometry = {
  scrollLength,
  insetStart,
  insetEnd,
  contentLength: contentSize - insetEnd,
};

describe("patched LegendList getIsAtEnd", () => {
  it("does not report the start edge as the end when content overflows below the header inset", () => {
    expect(isAtEnd({ ...deviceGeometry, scroll: contentSize - scrollLength })).toBe(true);
    expect(isAtEnd({ ...deviceGeometry, contentLength: 758 - insetEnd, scroll: -insetStart })).toBe(
      true,
    );

    expect(
      isAtEnd({ ...deviceGeometry, scroll: -insetStart }),
      "a feed pulled to its start edge (scroll -116) is 77.8pt from its end",
    ).toBe(false);
  });
});
