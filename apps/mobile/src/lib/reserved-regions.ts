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
  readonly hasHinge?: boolean;
  readonly horizontalSizeClass: "compact" | "regular";
  readonly verticalBarEdge: "none" | "left" | "right";
  readonly safeArea: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  };
  readonly reservedRegions: ReadonlyArray<ReservedRegion>;
  /** How far above the bottom edge UIKit floats a 48pt bottom bar, level with its tab bar. iOS 27.1+. */
  readonly bottomBarInset?: number;
}

function isFullHeightDivision(region: ReservedRegion, metrics: NativeLayoutMetrics) {
  return region.kind === "division" && region.height >= metrics.height / 2;
}

function sideOfDivision(left: number, right: number, x: number, endX: number) {
  if (x <= left) return { left: Math.min(right, endX), right };
  if (endX >= right) return { left, right: Math.max(left, x) };
  return right - endX >= x - left ? { left: endX, right } : { left, right: x };
}

export function deriveContentSideInsets(metrics: NativeLayoutMetrics | null) {
  if (!metrics) return { left: 0, right: 0 };
  let left = metrics.safeArea.left;
  let right = metrics.width - metrics.safeArea.right;
  for (const region of metrics.reservedRegions) {
    if (!isFullHeightDivision(region, metrics)) continue;
    const x = Math.max(left, region.x);
    const endX = Math.min(right, region.x + region.width);
    if (endX <= x) continue;
    ({ left, right } = sideOfDivision(left, right, x, endX));
  }
  return { left, right: metrics.width - right };
}

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
    if (isFullHeightDivision(region, metrics)) {
      ({ left, right } = sideOfDivision(left, right, x, endX));
    } else if (endY >= bottom - metrics.safeArea.bottom) {
      if (region.width >= right - left) bottom = y;
      else if (right - endX >= x - left) left = endX;
      else right = x;
    }
  }
  return { left, right: metrics.width - right, bottom: metrics.height - bottom };
}

/**
 * Where a bar can share the top safe area with the system status, as Safari does on iPhone Duo:
 * the status block covers one end of that band, so the rest of it is free. Null otherwise.
 */
export function deriveSharedTopBand(metrics: NativeLayoutMetrics | null) {
  if (!metrics || metrics.safeArea.top <= 0) return null;
  const blocks = metrics.reservedRegions.filter(
    (region) =>
      region.kind === "occlusion" && region.y <= 0 && region.height >= metrics.safeArea.top - 1,
  );
  const [block] = blocks;
  if (blocks.length !== 1 || !block) return null;
  const height = metrics.safeArea.top;
  if (block.x > metrics.width / 2 && block.x + block.width >= metrics.width - 1) {
    return { height, left: 0, right: metrics.width - block.x };
  }
  if (block.x <= 1 && block.x + block.width < metrics.width / 2) {
    return { height, left: block.x + block.width, right: 0 };
  }
  return null;
}
