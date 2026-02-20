export const AUTO_SCROLL_BOTTOM_EPSILON_PX = 2;

interface ScrollPosition {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function isScrollContainerAtBottom(
  position: ScrollPosition,
  epsilonPx = AUTO_SCROLL_BOTTOM_EPSILON_PX,
): boolean {
  const epsilon = Number.isFinite(epsilonPx)
    ? Math.max(0, epsilonPx)
    : AUTO_SCROLL_BOTTOM_EPSILON_PX;

  const { scrollTop, clientHeight, scrollHeight } = position;
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) {
    return true;
  }

  const distanceFromBottom = Math.max(0, scrollHeight - clientHeight - scrollTop);
  return distanceFromBottom <= epsilon;
}
