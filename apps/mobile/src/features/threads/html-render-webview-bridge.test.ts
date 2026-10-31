import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  HTML_RENDER_INLINE_SCRIPT,
  readHtmlRenderInlineMessage,
} from "./html-render-webview-bridge";

function runBridge(height = 240.25) {
  const root = {
    height,
    style: { overflowY: "visible", position: "static" },
    clientTop: 0,
    scrollHeight: Math.max(400, height),
    clientHeight: 400,
    scrollWidth: 320,
    getBoundingClientRect: () => ({ top: 0, height: root.height }),
  };
  const rootPseudos = new Map<string, Record<string, string>>();
  const positioned = {
    nodeType: 1,
    bottom: 0,
    scrollHeight: 0,
    clientHeight: 0,
    clientTop: 0,
    firstChild: null,
    nextSibling: null,
    style: { display: "block", position: "absolute", overflowY: "visible" },
    getBoundingClientRect: () => ({ top: 0, bottom: positioned.bottom }),
  };
  const text = { nodeType: 3, textContent: "Overflow text", bottom: 900, nextSibling: null };
  const body = {
    scrollHeight: height,
    scrollWidth: 320,
    firstChild: positioned as typeof positioned | typeof text | null,
    style: { display: "block", position: "static", overflowY: "visible" },
    getBoundingClientRect: () => ({ bottom: root.height }),
  };
  const frames: Array<() => void> = [];
  const windowEvents = new Map<string, () => void>();
  const documentEvents = new Map<string, () => void>();
  const fontEvents = new Map<string, () => void>();
  const fontReady = Promise.withResolvers<void>();
  const resizeCallbacks = new Map<object, () => void>();
  const mutationCallbacks: Array<() => void> = [];
  const observeMutations = vi.fn();
  class ResizeObserver {
    constructor(readonly callback: () => void) {}
    observe(target: object) {
      resizeCallbacks.set(target, this.callback);
    }
  }
  class MutationObserver {
    constructor(callback: () => void) {
      mutationCallbacks.push(callback);
    }
    observe = observeMutations;
  }
  const postMessage = vi.fn<(data: string) => void>();
  const window = {
    innerWidth: 320,
    innerHeight: 400,
    scrollY: 0,
    getComputedStyle: (element: typeof body | typeof positioned | typeof root, pseudo?: string) =>
      pseudo ? (rootPseudos.get(pseudo) ?? { content: "none" }) : element.style,
    ResizeObserver,
    MutationObserver,
    ReactNativeWebView: { postMessage },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    addEventListener: (name: string, callback: () => void) => windowEvents.set(name, callback),
  };
  const document = {
    documentElement: root,
    body,
    createRange: () => {
      let selected = text;
      return {
        selectNode: (node: typeof text) => {
          selected = node;
        },
        getBoundingClientRect: () => ({ bottom: selected.bottom }),
      };
    },
    addEventListener: vi.fn((name: string, callback: () => void) =>
      documentEvents.set(name, callback),
    ),
    fonts: {
      ready: fontReady.promise,
      addEventListener: (name: string, callback: () => void) => fontEvents.set(name, callback),
    },
  };
  NodeVM.runInNewContext(HTML_RENDER_INLINE_SCRIPT, {
    window,
    document,
    ResizeObserver,
    MutationObserver,
  });
  return {
    root,
    rootPseudos,
    body,
    positioned,
    text,
    window,
    document,
    fontReady,
    frames,
    observeMutations,
    resize: (target: object = root) => resizeCallbacks.get(target)?.(),
    mutate: () => mutationCallbacks.forEach((callback) => callback()),
    windowEvent: (name: string) => windowEvents.get(name)?.(),
    documentEvent: (name: string) => documentEvents.get(name)?.(),
    fontEvent: (name: string) => fontEvents.get(name)?.(),
    flushFrame: () => frames.splice(0).forEach((callback) => callback()),
    messages: () => postMessage.mock.calls.map(([data]) => readHtmlRenderInlineMessage(data)),
  };
}

describe("HTML render inline bridge", () => {
  it("reports the initial intrinsic root height without flooring it at the viewport", () => {
    const bridge = runBridge();
    expect(bridge.messages()).toEqual([{ contentHeight: 241, x: false, y: false }]);
  });

  it("reports growth even when both overflow flags stay the same", () => {
    const bridge = runBridge(2400);
    bridge.root.scrollHeight = 3200;
    bridge.resize();
    bridge.flushFrame();
    expect(bridge.messages()).toEqual([
      { contentHeight: 2400, x: false, y: true },
      { contentHeight: 3200, x: false, y: true },
    ]);
  });

  it("shrinks after the native frame has expanded to fit the content", () => {
    const bridge = runBridge(2400);
    bridge.window.innerHeight = 2400;
    bridge.root.clientHeight = 2400;
    bridge.root.height = 180.25;
    bridge.body.scrollHeight = 180.25;
    bridge.resize();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)).toEqual({ contentHeight: 181, x: false, y: false });
  });

  it("keeps positioned overflow fitted after the viewport grows, then shrinks when removed", () => {
    const bridge = runBridge(100);
    bridge.positioned.bottom = 900;
    bridge.root.scrollHeight = 900;
    bridge.mutate();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)).toEqual({ contentHeight: 900, x: false, y: true });

    bridge.root.clientHeight = 900;
    bridge.window.innerHeight = 900;
    bridge.windowEvent("resize");
    bridge.flushFrame();
    expect(bridge.messages().at(-1)).toEqual({ contentHeight: 900, x: false, y: false });
    bridge.resize();
    bridge.flushFrame();
    expect(bridge.messages()).toHaveLength(3);

    bridge.body.firstChild = null;
    bridge.mutate();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)).toEqual({ contentHeight: 100, x: false, y: false });
  });

  it("keeps pseudo-element overflow fitted and shrinks when removed", () => {
    const bridge = runBridge(100);
    bridge.positioned.bottom = 100;
    bridge.positioned.scrollHeight = 900;
    bridge.positioned.clientHeight = 100;
    bridge.root.scrollHeight = 900;
    bridge.mutate();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(900);
    bridge.root.clientHeight = bridge.window.innerHeight = 900;
    bridge.resize();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(900);
    bridge.positioned.scrollHeight = 100;
    bridge.mutate();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(100);
  });

  it.each(["::before", "::after"])("keeps root %s overflow fitted until removed", (pseudo) => {
    const bridge = runBridge(100);
    bridge.rootPseudos.set(pseudo, {
      content: '"tail"',
      position: "absolute",
      display: "block",
      top: "800px",
      height: "100px",
      boxSizing: "border-box",
    });
    bridge.root.scrollHeight = 900;
    bridge.mutate();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(900);
    bridge.root.clientHeight = bridge.window.innerHeight = 900;
    bridge.resize();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(900);
    bridge.rootPseudos.clear();
    bridge.mutate();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(100);
  });

  it("does not clip body overflow propagated to the viewport", () => {
    const bridge = runBridge(100);
    bridge.body.style.overflowY = "hidden";
    bridge.positioned.bottom = 900;
    bridge.root.scrollHeight = 900;
    bridge.mutate();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(900);
    bridge.root.clientHeight = bridge.window.innerHeight = 900;
    bridge.resize();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(900);
  });

  it("reports a cleared page so the client can apply its minimum height", () => {
    const bridge = runBridge(900);
    bridge.root.clientHeight = bridge.window.innerHeight = 900;
    bridge.root.height = bridge.body.scrollHeight = 0;
    bridge.body.firstChild = null;
    bridge.mutate();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(1);
  });

  it.each(["auto", "hidden", "clip"])(
    "does not fit content clipped by an overflow:%s container",
    (overflowY) => {
      const bridge = runBridge(100);
      bridge.root.scrollHeight = bridge.root.clientHeight = 900;
      bridge.positioned.bottom = 1500;
      bridge.body.style.overflowY = overflowY;
      bridge.root.style.overflowY = "hidden";
      bridge.resize();
      bridge.flushFrame();
      expect(bridge.messages().at(-1)?.contentHeight).toBe(100);
    },
  );

  it("measures text overflow independently of its element's fixed box height", () => {
    const bridge = runBridge(100);
    bridge.body.firstChild = bridge.text;
    bridge.root.scrollHeight = bridge.root.clientHeight = 900;
    bridge.resize();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(900);
  });

  it.each([
    { display: "none", position: "absolute" },
    { display: "block", position: "fixed" },
  ])("does not fit hidden or viewport-fixed elements: %o", (style) => {
    const bridge = runBridge(100);
    bridge.positioned.bottom = 1500;
    Object.assign(bridge.positioned.style, style);
    bridge.resize();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(100);
  });

  it("remeasures wrapping when the viewport width changes", () => {
    const bridge = runBridge(600);
    bridge.window.innerWidth = 640;
    bridge.root.scrollWidth = 640;
    bridge.root.scrollHeight = 400;
    bridge.root.height = 300;
    bridge.body.scrollWidth = 640;
    bridge.body.scrollHeight = 300;
    bridge.windowEvent("resize");
    bridge.flushFrame();
    expect(bridge.messages().at(-1)).toEqual({ contentHeight: 300, x: false, y: false });
  });

  it("coalesces observer bursts and suppresses duplicate measurements", () => {
    const bridge = runBridge();
    bridge.resize();
    bridge.resize(bridge.body);
    bridge.mutate();
    bridge.windowEvent("resize");
    expect(bridge.frames).toHaveLength(1);
    bridge.flushFrame();
    expect(bridge.messages()).toHaveLength(1);
    expect(bridge.frames).toHaveLength(0);

    bridge.root.scrollWidth = 700;
    bridge.resize();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)).toEqual({ contentHeight: 241, x: true, y: false });
    bridge.root.scrollWidth = 320;
    bridge.resize();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)).toEqual({ contentHeight: 241, x: false, y: false });
  });

  it("remeasures positioned descendants after mutations without a root or body resize", () => {
    const bridge = runBridge(2400);
    expect(bridge.observeMutations).toHaveBeenCalledWith(bridge.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "open"],
    });
    bridge.root.scrollHeight = 3100;
    bridge.mutate();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)).toEqual({ contentHeight: 3100, x: false, y: true });

    bridge.root.scrollHeight = 2800;
    bridge.mutate();
    bridge.flushFrame();
    expect(bridge.messages().at(-1)).toEqual({ contentHeight: 2800, x: false, y: true });
  });

  it.each(["document", "window"] as const)("remeasures after %s load events", (target) => {
    const bridge = runBridge(2400);
    bridge.root.scrollHeight = 3000;
    if (target === "document") {
      expect(bridge.document.addEventListener).toHaveBeenCalledWith(
        "load",
        expect.any(Function),
        true,
      );
      bridge.documentEvent("load");
    } else {
      bridge.windowEvent("load");
    }
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(3000);
  });

  it("remeasures after initial and dynamically loaded fonts settle", async () => {
    const bridge = runBridge(600);
    bridge.root.scrollHeight = 650;
    bridge.fontReady.resolve();
    await bridge.fontReady.promise;
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(650);

    bridge.root.scrollHeight = 700;
    bridge.fontEvent("loadingdone");
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(700);
    bridge.root.scrollHeight = 620;
    bridge.fontEvent("loadingerror");
    bridge.flushFrame();
    expect(bridge.messages().at(-1)?.contentHeight).toBe(620);
  });

  it.each([-10, NaN, Infinity])("ignores invalid intrinsic height %s and recovers", (height) => {
    const bridge = runBridge(height);
    expect(bridge.messages()).toHaveLength(0);
    bridge.root.scrollHeight = 400;
    bridge.root.height = 300;
    bridge.body.scrollHeight = 300;
    bridge.resize();
    bridge.flushFrame();
    expect(bridge.messages()).toEqual([{ contentHeight: 300, x: false, y: false }]);
  });
});

describe("readHtmlRenderInlineMessage", () => {
  it("accepts finite positive heights with boolean overflow flags", () => {
    expect(
      readHtmlRenderInlineMessage(
        '{"type":"t3-html-render-overflow","contentHeight":1200.5,"x":true,"y":false}',
      ),
    ).toEqual({ contentHeight: 1200.5, x: true, y: false });
  });

  it.each([
    "invalid JSON",
    "null",
    "[]",
    '"message"',
    "{}",
    '{"type":"other","contentHeight":400,"x":false,"y":false}',
    '{"type":"t3-html-render-overflow","x":false,"y":false}',
    '{"type":"t3-html-render-overflow","contentHeight":"400","x":false,"y":false}',
    '{"type":"t3-html-render-overflow","contentHeight":null,"x":false,"y":false}',
    '{"type":"t3-html-render-overflow","contentHeight":0,"x":false,"y":false}',
    '{"type":"t3-html-render-overflow","contentHeight":-1,"x":false,"y":false}',
    '{"type":"t3-html-render-overflow","contentHeight":1e999,"x":false,"y":false}',
    '{"type":"t3-html-render-overflow","contentHeight":400,"x":"false","y":false}',
    '{"type":"t3-html-render-overflow","contentHeight":400,"x":false}',
  ])("ignores malformed bridge payloads: %s", (data) => {
    expect(readHtmlRenderInlineMessage(data)).toBeNull();
  });
});
