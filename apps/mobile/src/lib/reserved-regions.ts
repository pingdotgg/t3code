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
      // A native column ending at a division is already split there. Only an
      // interior division needs to move these controls into one side of the view.
      if (x <= left || endX >= right) continue;
      if (right - endX >= x - left) left = endX;
      else right = x;
    } else if (endY >= bottom - metrics.safeArea.bottom) {
      if (region.width >= right - left) bottom = y;
      else if (right - endX >= x - left) left = endX;
      else right = x;
    }
  }
  return { left, right: metrics.width - right, bottom: metrics.height - bottom };
}

const VERTICAL_BAR_ITEM_PITCH = 52;
const VERTICAL_BAR_GROUP_TRIM = 4;
const VERTICAL_BAR_GROUP_GAP = 12;
const TAB_BAR_ITEM_PITCH = 50;
const TAB_BAR_PADDING = 12;

function verticalBarTopEdge(metrics: NativeLayoutMetrics) {
  let top = metrics.safeArea.top;
  for (const region of metrics.reservedRegions) {
    if (region.kind !== "occlusion" || region.y > top) continue;
    const onBarEdge =
      metrics.verticalBarEdge === "right"
        ? region.x + region.width > metrics.width - metrics.safeArea.right
        : region.x < metrics.safeArea.left;
    if (onBarEdge) top = Math.max(top, region.y + region.height);
  }
  return top;
}

export function verticalBarGroupsFitAboveTabBar(
  metrics: NativeLayoutMetrics,
  tabCount: number,
  groupSizes: readonly number[],
) {
  const groups = groupSizes.filter((size) => size > 0);
  const needed = groups.reduce(
    (length, size) =>
      length + size * VERTICAL_BAR_ITEM_PITCH - VERTICAL_BAR_GROUP_TRIM + VERTICAL_BAR_GROUP_GAP,
    0,
  );
  const tabBarTop =
    metrics.height -
    (metrics.bottomBarInset ?? metrics.safeArea.bottom) -
    tabCount * TAB_BAR_ITEM_PITCH -
    TAB_BAR_PADDING;
  return verticalBarTopEdge(metrics) + needed <= tabBarTop;
}
