interface Point {
  readonly x: number;
  readonly y: number;
}

interface Rect extends Point {
  readonly width: number;
  readonly height: number;
}

// clientX/Y and getBoundingClientRect are layout-viewport coordinates; native window coordinates
// follow what is drawn, which moves while the desktop window is pinch-magnified and panned.
export function toVisualViewportPoint(point: Point): Point {
  const viewport = window.visualViewport;
  if (!viewport) return point;
  return {
    x: (point.x - viewport.offsetLeft) * viewport.scale,
    y: (point.y - viewport.offsetTop) * viewport.scale,
  };
}

export function toVisualViewportRect(rect: Rect): Rect {
  const scale = window.visualViewport?.scale ?? 1;
  return {
    ...toVisualViewportPoint(rect),
    width: rect.width * scale,
    height: rect.height * scale,
  };
}
