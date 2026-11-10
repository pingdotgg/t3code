import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);

// checkAtBottom is internal to the patched bundle; expose it from the native build as seen on iOS.
function loadPatchedCheckAtBottom() {
  const webBundlePath = require.resolve("@legendapp/list/react-native");
  const bundlePath = NodePath.join(NodePath.dirname(webBundlePath), "react-native.js");
  const source = `${NodeFS.readFileSync(bundlePath, "utf8")}\nmodule.exports.checkAtBottom = checkAtBottom;`;
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
  const module = { exports: {} as { checkAtBottom?: (ctx: unknown) => void } };
  NodeVM.compileFunction(source, ["exports", "require", "module"], { filename: bundlePath })(
    module.exports,
    (id: string) => (id === "react-native" ? reactNative : inert),
    module,
  );
  const checkAtBottom = module.exports.checkAtBottom;
  if (!checkAtBottom) throw new Error(`checkAtBottom not found in ${bundlePath}`);
  return checkAtBottom;
}

const checkAtBottom = loadPatchedCheckAtBottom();

// iPhone 17 Pro thread feed: header inset 116, composer inset 142.5, rows 693.29,
// so the end rests at -38.21 and the start at -116.
const scrollLength = 874;
const insetTop = 116;
const insetBottom = 142.5;

function isAtEnd(scroll: number, rowsLength = 835.79 - insetBottom) {
  const values = new Map<string, unknown>([["totalSize", rowsLength]]);
  checkAtBottom({
    values,
    listeners: new Map(),
    scrollAxisGap: 0,
    state: {
      queuedInitialLayout: true,
      maintainingScrollAtEnd: true,
      scroll,
      scrollLength,
      props: {
        data: [{}],
        contentInset: { top: insetTop, bottom: insetBottom },
        maintainScrollAtEndThreshold: 0,
        onEndReachedThreshold: 0,
      },
    },
  });
  return values.get("isAtEnd");
}

describe("patched LegendList checkAtBottom", () => {
  it("does not report the start edge as the end when content overflows below the header inset", () => {
    expect(isAtEnd(835.79 - scrollLength)).toBe(true);
    expect(isAtEnd(-insetTop, 758 - insetBottom), "content that exactly fits").toBe(true);

    expect(
      isAtEnd(-insetTop),
      "a feed pulled to its start edge (scroll -116) is 77.8pt from its end",
    ).toBe(false);
    expect(isAtEnd(-114), "a feed just below its start edge is 75.8pt from its end").toBe(false);
  });
});
