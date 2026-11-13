import { expect, it } from "vite-plus/test";

import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";

it.each([1, 2])("refits every background capture edge at layout zoom %i", (zoom) => {
  for (const viewport of [
    { width: 390, height: 600 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 3440, height: 1440 },
    { width: 390, height: 600 },
  ]) {
    const hiddenSize = { width: viewport.width * zoom, height: viewport.height * zoom };
    for (const windowSize of [
      { width: 1840, height: 1016 },
      { width: 1000, height: 668 },
      { width: 1840, height: 1016 },
    ]) {
      const input = { active: false, renderingActive: true, rect: null, hiddenSize, windowSize };
      const style = resolveHostedBrowserWebviewWrapperStyle(input);
      const transform = style.transform;
      const scale =
        transform === undefined ? 1 : Number(String(transform).match(/^scale\((.+)\)$/)?.[1]);

      expect({ width: style.width, height: style.height }).toEqual(hiddenSize);
      expect(scale).toBeGreaterThan(0);
      expect(scale).toBeLessThanOrEqual(1);
      for (const [x, y] of [
        [0, 0],
        [style.width, 0],
        [0, style.height],
        [style.width, style.height],
      ] as const) {
        expect(style.left + x * scale).toBeGreaterThanOrEqual(0);
        expect(style.top + y * scale).toBeGreaterThanOrEqual(0);
        expect(style.left + x * scale).toBeLessThanOrEqual(windowSize.width + 1e-9);
        expect(style.top + y * scale).toBeLessThanOrEqual(windowSize.height + 1e-9);
      }
      expect((style.width * scale) / (style.height * scale)).toBeCloseTo(
        hiddenSize.width / hiddenSize.height,
      );
      if (scale < 1) {
        expect(style).toMatchObject({ transformOrigin: "top left" });
        expect(
          Math.max(
            (style.width * scale) / windowSize.width,
            (style.height * scale) / windowSize.height,
          ),
        ).toBeCloseTo(1);
      }
      expect(style).toMatchObject({ zIndex: -1, pointerEvents: "none", visibility: "visible" });
    }
  }
});

it("releases the capture transform when a tab is shown or suspended", () => {
  const input = {
    active: false,
    renderingActive: true,
    rect: { x: 120, y: 80, width: 600, height: 400 },
    hiddenSize: { width: 3440, height: 1440 },
    windowSize: { width: 1000, height: 668 },
    cornerRadius: 8,
    zIndex: 40,
  };
  expect(resolveHostedBrowserWebviewWrapperStyle(input)).toHaveProperty("transform");
  expect(resolveHostedBrowserWebviewWrapperStyle({ ...input, active: true })).toEqual({
    left: 120,
    top: 80,
    width: 600,
    height: 400,
    zIndex: 40,
    pointerEvents: "auto",
    borderRadius: 8,
  });
  for (const keepPaintableWhenInactive of [false, true]) {
    const suspended = resolveHostedBrowserWebviewWrapperStyle({
      ...input,
      renderingActive: false,
      keepPaintableWhenInactive,
    });
    expect(suspended).not.toHaveProperty("transform");
    expect(suspended).toMatchObject({
      width: 3440,
      height: 1440,
      pointerEvents: "none",
      visibility: keepPaintableWhenInactive ? "visible" : "hidden",
    });
    expect(suspended.left + suspended.width).toBeLessThan(0);
    expect(suspended.top + suspended.height).toBeLessThan(0);
  }
});
