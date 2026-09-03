export const PAGE_SCROLL_ANIMATION_MS = 150;
export const PAGE_SCROLL_ACCELERATION_MS = 400;
export const PAGE_SCROLL_MAX_MULTIPLIER = 2;

const PAGE_SCROLL_ALIGNMENT_OFFSET_PX = 36;
const PAGE_SCROLL_BOUNDARY_EPSILON_PX = 1;
const PAGE_SCROLL_HOLD_DELAY_MS = PAGE_SCROLL_ANIMATION_MS;

export type PageScrollKey = "PageUp" | "PageDown";

type PageScrollMetrics = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

function canScrollInDirection(
  { clientHeight, scrollHeight, scrollTop }: PageScrollMetrics,
  key: PageScrollKey,
): boolean {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const clampedScrollTop = Math.min(maxScrollTop, Math.max(0, scrollTop));
  return key === "PageUp"
    ? clampedScrollTop > PAGE_SCROLL_BOUNDARY_EPSILON_PX
    : clampedScrollTop < maxScrollTop - PAGE_SCROLL_BOUNDARY_EPSILON_PX;
}

export function getTimelinePageScrollKey({
  altKey,
  clientHeight,
  ctrlKey,
  defaultPrevented,
  isComposing,
  key,
  keyCode,
  metaKey,
  scrollHeight,
  scrollTop,
  shiftKey,
}: {
  altKey: boolean;
  clientHeight: number;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  isComposing: boolean;
  key: string;
  keyCode: number;
  metaKey: boolean;
  scrollHeight: number;
  scrollTop: number;
  shiftKey: boolean;
}): PageScrollKey | null {
  if (key !== "PageUp" && key !== "PageDown") {
    return null;
  }
  if (
    defaultPrevented ||
    isComposing ||
    keyCode === 229 ||
    altKey ||
    ctrlKey ||
    metaKey ||
    shiftKey
  ) {
    return null;
  }

  const editorCanScroll = canScrollInDirection({ clientHeight, scrollHeight, scrollTop }, key);
  return editorCanScroll ? null : key;
}

type PageScrollContainer = PageScrollMetrics & {
  getBoundingClientRect: () => {
    height: number;
  };
};

type PageScrollEnv = {
  now: () => number;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (handle: number) => void;
};

function getDefaultEnv(): PageScrollEnv {
  return {
    now: () => performance.now(),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (handle) => window.clearTimeout(handle),
  };
}

export function getPageScrollMultiplier(holdElapsedMs: number): number {
  const progress = Math.max(0, holdElapsedMs) / PAGE_SCROLL_ACCELERATION_MS;
  return 1 + Math.min(progress, 1) * (PAGE_SCROLL_MAX_MULTIPLIER - 1);
}

export function getPageScrollVelocityPxPerMs({
  holdElapsedMs,
  pageScrollDistancePx,
}: {
  holdElapsedMs: number;
  pageScrollDistancePx: number;
}): number {
  return (pageScrollDistancePx * getPageScrollMultiplier(holdElapsedMs)) / PAGE_SCROLL_ANIMATION_MS;
}

export function getPageScrollDistancePx({
  containerHeightPx,
  scrollPaddingBottomPx,
}: {
  containerHeightPx: number;
  scrollPaddingBottomPx: number;
}): number {
  return Math.max(0, containerHeightPx - PAGE_SCROLL_ALIGNMENT_OFFSET_PX - scrollPaddingBottomPx);
}

function getDirection(key: PageScrollKey): -1 | 1 {
  return key === "PageUp" ? -1 : 1;
}

function easeInOut(progress: number): number {
  const ax = 3 * 0.42 - 3 * 0.58 + 1;
  const bx = 3 * (0.58 - 2 * 0.42);
  const cx = 3 * 0.42;
  const ay = -2;
  const by = 3;
  const x = (value: number) => ((ax * value + bx) * value + cx) * value;
  const y = (value: number) => (ay * value + by) * value * value;

  let value = progress;
  for (let index = 0; index < 5; index += 1) {
    const delta = x(value) - progress;
    const derivative = (3 * ax * value + 2 * bx) * value + cx;
    if (Math.abs(delta) < 1e-4 || derivative === 0) {
      break;
    }
    value -= delta / derivative;
    value = Math.min(1, Math.max(0, value));
  }

  return y(value);
}

export function createPageScrollController({
  getContainer,
  getScrollPaddingBottomPx,
  onScrollStart,
  env = getDefaultEnv(),
}: {
  getContainer: () => PageScrollContainer | null;
  getScrollPaddingBottomPx: () => number;
  onScrollStart?: (key: PageScrollKey) => void;
  env?: PageScrollEnv;
}) {
  const state = {
    activeKey: null as PageScrollKey | null,
    discreteAnimationFrame: 0,
    holdDelayTimeout: 0,
    holdAnimationFrame: 0,
    holdStartTime: 0,
    lastFrameTime: 0,
    holdActive: false,
  };

  const readPageScrollDistance = (container: PageScrollContainer) =>
    getPageScrollDistancePx({
      containerHeightPx: container.getBoundingClientRect().height,
      scrollPaddingBottomPx: getScrollPaddingBottomPx(),
    });

  const cancelDiscreteAnimation = () => {
    if (state.discreteAnimationFrame === 0) {
      return;
    }

    env.cancelAnimationFrame(state.discreteAnimationFrame);
    state.discreteAnimationFrame = 0;
  };

  const stop = ({
    cancelDiscreteAnimation: shouldCancelDiscreteAnimation,
  }: {
    cancelDiscreteAnimation: boolean;
  }) => {
    if (state.holdDelayTimeout !== 0) {
      env.clearTimeout(state.holdDelayTimeout);
      state.holdDelayTimeout = 0;
    }

    if (state.holdAnimationFrame !== 0) {
      env.cancelAnimationFrame(state.holdAnimationFrame);
      state.holdAnimationFrame = 0;
    }

    if (shouldCancelDiscreteAnimation) {
      cancelDiscreteAnimation();
    }

    state.activeKey = null;
    state.holdStartTime = 0;
    state.lastFrameTime = 0;
    state.holdActive = false;
  };

  const smoothScrollBy = (container: PageScrollContainer, deltaY: number) => {
    cancelDiscreteAnimation();

    const startScrollTop = container.scrollTop;
    const startTime = env.now();

    const step = (now: number) => {
      const progress = Math.min(1, (now - startTime) / PAGE_SCROLL_ANIMATION_MS);
      container.scrollTop = startScrollTop + deltaY * easeInOut(progress);

      if (progress < 1) {
        state.discreteAnimationFrame = env.requestAnimationFrame(step);
        return;
      }

      state.discreteAnimationFrame = 0;
    };

    state.discreteAnimationFrame = env.requestAnimationFrame(step);
  };

  const startHoldScroll = (key: PageScrollKey, container: PageScrollContainer) => {
    cancelDiscreteAnimation();
    state.holdActive = true;
    state.holdStartTime = env.now();
    state.lastFrameTime = state.holdStartTime;

    const step = (now: number) => {
      if (state.activeKey !== key) {
        state.holdAnimationFrame = 0;
        return;
      }

      const deltaMs = now - state.lastFrameTime;
      state.lastFrameTime = now;

      const velocityPxPerMs = getPageScrollVelocityPxPerMs({
        holdElapsedMs: now - state.holdStartTime,
        pageScrollDistancePx: readPageScrollDistance(container),
      });
      const previousScrollTop = container.scrollTop;
      container.scrollTop = previousScrollTop + velocityPxPerMs * deltaMs * getDirection(key);

      if (deltaMs > 0 && container.scrollTop === previousScrollTop) {
        stop({ cancelDiscreteAnimation: true });
        return;
      }

      state.holdAnimationFrame = env.requestAnimationFrame(step);
    };

    state.holdAnimationFrame = env.requestAnimationFrame(step);
  };

  return {
    handleKeyDown(key: PageScrollKey) {
      const container = getContainer();
      if (!container) {
        return;
      }

      if (!canScrollInDirection(container, key)) {
        return;
      }

      if (state.activeKey === key) {
        return;
      }

      stop({ cancelDiscreteAnimation: true });
      state.activeKey = key;
      onScrollStart?.(key);

      smoothScrollBy(container, readPageScrollDistance(container) * getDirection(key));

      state.holdDelayTimeout = env.setTimeout(() => {
        state.holdDelayTimeout = 0;
        if (state.activeKey !== key) {
          return;
        }

        startHoldScroll(key, container);
      }, PAGE_SCROLL_HOLD_DELAY_MS);
    },
    handleKeyUp(key: string) {
      if (state.activeKey !== key) {
        return;
      }

      stop({ cancelDiscreteAnimation: state.holdActive });
    },
    releaseActiveKey() {
      stop({ cancelDiscreteAnimation: state.holdActive });
    },
    dispose() {
      stop({ cancelDiscreteAnimation: true });
    },
  };
}
