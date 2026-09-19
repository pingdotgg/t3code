export interface ReservedRegion {
  readonly kind: "division" | "occlusion";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NativeLayoutMetrics {
  readonly width: number;
  readonly height: number;
  readonly horizontalSizeClass: "compact" | "regular";
  readonly verticalBarEdge: "none" | "left" | "right";
  readonly safeArea: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  };
  readonly reservedRegions: ReadonlyArray<ReservedRegion>;
}

/**
 * Keep bottom controls in one usable region. A book-like fold selects the
 * larger side; a horizontal fold leaves the controls on the lower display.
 * Text and other scrollable content can continue to use the full canvas.
 */
export function deriveBottomControlInsets(metrics: NativeLayoutMetrics | null) {
  if (!metrics) return { left: 0, right: 0, bottom: 0 };
  let left = metrics.safeArea.left;
  let right = metrics.width - metrics.safeArea.right;
  let bottom = metrics.height;
  for (const region of metrics.reservedRegions) {
    const x = Math.max(left, region.x);
    const endX = Math.min(right, region.x + region.width);
    const y = Math.max(0, region.y);
    const endY = Math.min(bottom, region.y + region.height);
    if (endX <= x || endY <= y) continue;
    if (region.kind === "division" && region.height >= metrics.height / 2) {
      if (right - endX >= x - left) left = endX;
      else right = x;
    } else if (endY >= bottom - metrics.safeArea.bottom) {
      // An occlusion at the bottom can also occupy just one corner.
      if (region.width >= right - left) bottom = y;
      else if (right - endX >= x - left) left = endX;
      else right = x;
    }
  }
  return { left, right: metrics.width - right, bottom: metrics.height - bottom };
}
