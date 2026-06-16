export interface ThreadFeedScrollMetrics {
  readonly contentHeight: number;
  readonly viewportHeight: number;
  readonly offsetY: number;
  readonly bottomInset: number;
}

export function threadFeedDistanceFromEnd(metrics: ThreadFeedScrollMetrics): number {
  return metrics.contentHeight + metrics.bottomInset - metrics.viewportHeight - metrics.offsetY;
}

export function isThreadFeedNearEnd(metrics: ThreadFeedScrollMetrics, threshold: number): boolean {
  return threadFeedDistanceFromEnd(metrics) <= threshold;
}

export function resolveThreadFeedBottomInset(input: {
  readonly estimatedOverlayHeight: number;
  readonly measuredOverlayHeight: number;
  readonly gap: number;
}): number {
  return Math.max(input.estimatedOverlayHeight, input.measuredOverlayHeight) + input.gap;
}
