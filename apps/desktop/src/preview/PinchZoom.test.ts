import { describe, expect, it } from "vite-plus/test";

import { installPinchZoom, type PageZoom, UNZOOMED, zoomPage } from "./PinchZoom.ts";

describe("zoomPage", () => {
  it("keeps the point under the pointer still on screen", () => {
    const zoomed = zoomPage(UNZOOMED, 2, 400, 200, 1000, 800);
    expect(zoomed).toEqual({ scale: 2, x: 200, y: 100 });
    const again = zoomPage(zoomed, 1.5, 500, 300, 1000, 800);
    expect((500 - again.x) * again.scale).toBeCloseTo((500 - zoomed.x) * zoomed.scale);
    expect((300 - again.y) * again.scale).toBeCloseTo((300 - zoomed.y) * zoomed.scale);
  });

  it("keeps the visible region inside the page", () => {
    expect(zoomPage({ scale: 4, x: 750, y: 0 }, 0.5, 1000, 0, 1000, 800)).toEqual({
      scale: 2,
      x: 500,
      y: 0,
    });
  });

  it("caps the scale, snaps back to unzoomed, and lets a slow pinch start", () => {
    expect(zoomPage(UNZOOMED, 100, 0, 0, 1000, 800).scale).toBe(5);
    expect(zoomPage({ scale: 2, x: 100, y: 100 }, 0.504, 0, 0, 1000, 800)).toBe(UNZOOMED);
    expect(zoomPage(UNZOOMED, 1.005, 0, 0, 1000, 800).scale).toBeCloseTo(1.005);
  });
});

interface FakeWheel {
  readonly isTrusted: boolean;
  readonly ctrlKey: boolean;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly clientX: number;
  readonly clientY: number;
  defaultPrevented: boolean;
}

interface FakeFrame {
  readonly document: {
    readonly addEventListener: (type: string, next: (event: unknown) => void) => void;
    readonly querySelectorAll: () => unknown[];
  };
  readonly addEventListener: (type: string, next: (event: unknown) => void) => void;
  readonly getComputedStyle: () => { paddingLeft: string; paddingTop: string };
  readonly emit: (type: string, event: unknown) => void;
}

const makeFrame = (iframes: unknown[] = []): FakeFrame => {
  const listeners = new Map<string, (event: unknown) => void>();
  const listen = (type: string, next: (event: unknown) => void) => {
    listeners.set(type, next);
  };
  return {
    document: { addEventListener: listen, querySelectorAll: () => iframes },
    addEventListener: listen,
    getComputedStyle: () => ({ paddingLeft: "0px", paddingTop: "0px" }),
    emit: (type, event) => listeners.get(type)?.(event),
  };
};

/** An iframe element laid out at 200x100 with a 2px border, drawn at `scale`. */
const makeIframe = (contentWindow: FakeFrame, left: number, top: number, scale = 1) => ({
  nodeName: "IFRAME",
  contentWindow,
  clientLeft: 2,
  clientTop: 2,
  offsetWidth: 200,
  offsetHeight: 100,
  getBoundingClientRect: () => ({ left, top, width: 200 * scale, height: 100 * scale }),
});

const makePage = () => {
  const frame = makeFrame();
  const frames: Array<() => void> = [];
  const requests: PageZoom[] = [];
  const viewport = { scale: 1, offsetLeft: 0, offsetTop: 0, width: 1000, height: 800 };
  let time = 0;
  const target = Object.assign(frame, { visualViewport: viewport });
  const pinchZoom = installPinchZoom(
    target as unknown as Window,
    (zoom) => requests.push(zoom),
    (callback) => frames.push(callback),
    () => time,
  );
  const pinch = (deltaY: number, init: Partial<FakeWheel> = {}, inFrame: FakeFrame = frame) => {
    const event: FakeWheel = {
      isTrusted: true,
      ctrlKey: true,
      deltaY,
      deltaMode: 0,
      clientX: 0,
      clientY: 0,
      defaultPrevented: false,
      ...init,
    };
    inFrame.emit("wheel", event);
    return event;
  };
  const runFrames = () => {
    for (const frame of frames.splice(0)) frame();
  };
  const showZoom = (zoom: PageZoom) => {
    const layoutWidth = viewport.width * viewport.scale;
    const layoutHeight = viewport.height * viewport.scale;
    Object.assign(viewport, {
      scale: zoom.scale,
      offsetLeft: zoom.x,
      offsetTop: zoom.y,
      width: layoutWidth / zoom.scale,
      height: layoutHeight / zoom.scale,
    });
  };
  const wait = (ms: number) => {
    time += ms;
  };
  const loadIframe = (child: FakeFrame, left: number, top: number, scale = 1) => {
    frame.emit("load", { target: makeIframe(child, left, top, scale) });
    return child;
  };
  return { pinch, runFrames, requests, showZoom, wait, pinchZoom, loadIframe };
};

describe("installPinchZoom", () => {
  it("requests one zoom per frame for the pinches in it", () => {
    const page = makePage();
    page.pinch(-50);
    page.pinch(-50);
    expect(page.requests).toEqual([]);
    page.runFrames();
    expect(page.requests).toHaveLength(1);
    expect(page.requests[0]!.scale).toBeCloseTo(Math.E);
  });

  it("leaves pinches the page handled, and plain wheels, to the page", () => {
    const page = makePage();
    page.pinch(-100).defaultPrevented = true;
    page.pinch(-100, { ctrlKey: false });
    page.runFrames();
    expect(page.requests).toEqual([]);
  });

  it("keeps each pinch step the same size however far the page is zoomed", () => {
    const page = makePage();
    page.pinch(-50);
    page.runFrames();
    page.showZoom(page.requests[0]!);
    page.wait(1000);
    // Chromium hands the page a delta divided by its zoom.
    page.pinch(-50 / Math.sqrt(Math.E));
    page.runFrames();
    expect(page.requests[1]!.scale).toBeCloseTo(Math.E);
  });

  it("builds on its own requests mid-pinch, then on the page's zoom once the pinch pauses", () => {
    const page = makePage();
    page.pinch(-50);
    page.runFrames();
    page.pinch(-50);
    page.runFrames();
    expect(page.requests[1]!.scale).toBeCloseTo(Math.E);

    page.showZoom({ scale: 2, x: 30, y: 40 });
    page.wait(1000);
    page.pinch(-50 / 2);
    page.runFrames();
    expect(page.requests[2]!.scale).toBeCloseTo(2 * Math.sqrt(Math.E));
  });

  it("resets to unzoomed on request", () => {
    const page = makePage();
    page.pinch(-100);
    page.runFrames();
    page.pinchZoom.reset();
    expect(page.requests.at(-1)).toBe(UNZOOMED);
  });

  it("anchors a pinch over a same-origin frame at the pointer in the page", () => {
    const page = makePage();
    const child = page.loadIframe(makeFrame(), 100, 50);
    page.pinch(-100, { clientX: 8, clientY: 18 }, child);
    page.runFrames();
    expect(page.requests[0]).toEqual(zoomPage(UNZOOMED, Math.E, 110, 70, 1000, 800));
  });

  it("maps a pointer through an iframe drawn smaller than its layout size", () => {
    const page = makePage();
    const child = page.loadIframe(makeFrame(), 100, 50, 0.5);
    page.pinch(-100, { clientX: 78, clientY: 38 }, child);
    page.runFrames();
    expect(page.requests[0]).toEqual(zoomPage(UNZOOMED, Math.E, 140, 70, 1000, 800));
  });

  it("watches a nested frame that loaded before its parent frame", () => {
    const page = makePage();
    const grandchild = makeFrame();
    page.loadIframe(makeFrame([makeIframe(grandchild, 10, 20)]), 100, 50);
    page.pinch(-100, { clientX: 8, clientY: 8 }, grandchild);
    page.runFrames();
    expect(page.requests[0]).toEqual(zoomPage(UNZOOMED, Math.E, 122, 82, 1000, 800));
  });
});
