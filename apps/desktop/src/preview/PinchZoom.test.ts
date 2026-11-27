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

const makePage = () => {
  let listener: ((event: FakeWheel) => void) | null = null;
  const frames: Array<() => void> = [];
  const requests: PageZoom[] = [];
  const viewport = { scale: 1, offsetLeft: 0, offsetTop: 0, width: 1000, height: 800 };
  let time = 0;
  const target = {
    visualViewport: viewport,
    addEventListener: (_type: string, next: (event: FakeWheel) => void) => {
      listener = next;
    },
  };
  const pinchZoom = installPinchZoom(
    target as unknown as Window,
    (zoom) => requests.push(zoom),
    (callback) => frames.push(callback),
    () => time,
  );
  const pinch = (deltaY: number, init: Partial<FakeWheel> = {}) => {
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
    listener?.(event);
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
  return { pinch, runFrames, requests, showZoom, wait, pinchZoom };
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
});
