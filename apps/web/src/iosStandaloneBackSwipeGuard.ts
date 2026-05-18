import { isStandalonePwa } from "./env";

export const IOS_HISTORY_SWIPE_EDGE_WIDTH_PX = 24;

export type IosStandaloneBackSwipeGuardEnvironment = {
  readonly isStandalonePwa: boolean;
  readonly maxTouchPoints: number;
  readonly platform: string;
  readonly userAgent: string;
};

type InstallIosStandaloneBackSwipeGuardOptions = {
  readonly window?: Window;
  readonly isStandalonePwa?: () => boolean;
};

type TouchStartInput = {
  readonly cancelable: boolean;
  readonly clientX: number | null;
  readonly defaultPrevented: boolean;
  readonly edgeWidth?: number;
  readonly touchCount: number;
  readonly viewportWidth: number;
};

export function isIosTouchDevice(
  input: Pick<IosStandaloneBackSwipeGuardEnvironment, "maxTouchPoints" | "platform" | "userAgent">,
): boolean {
  const platform = input.platform.toLowerCase();
  const userAgent = input.userAgent.toLowerCase();

  return (
    userAgent.includes("iphone") ||
    userAgent.includes("ipad") ||
    userAgent.includes("ipod") ||
    (platform === "macintel" && input.maxTouchPoints > 1)
  );
}

export function shouldInstallIosStandaloneBackSwipeGuard(
  environment: IosStandaloneBackSwipeGuardEnvironment,
): boolean {
  return environment.isStandalonePwa && isIosTouchDevice(environment);
}

export function isHistorySwipeEdgeTouch(input: {
  readonly clientX: number;
  readonly edgeWidth?: number;
  readonly viewportWidth: number;
}): boolean {
  if (input.viewportWidth <= 0) {
    return false;
  }

  const edgeWidth = Math.min(
    Math.max(input.edgeWidth ?? IOS_HISTORY_SWIPE_EDGE_WIDTH_PX, 0),
    input.viewportWidth / 2,
  );

  return input.clientX <= edgeWidth || input.clientX >= input.viewportWidth - edgeWidth;
}

export function shouldPreventIosHistorySwipeTouchStart(input: TouchStartInput): boolean {
  if (
    !input.cancelable ||
    input.defaultPrevented ||
    input.touchCount !== 1 ||
    input.clientX === null
  ) {
    return false;
  }

  return isHistorySwipeEdgeTouch({
    clientX: input.clientX,
    ...(input.edgeWidth === undefined ? {} : { edgeWidth: input.edgeWidth }),
    viewportWidth: input.viewportWidth,
  });
}

export function installIosStandaloneBackSwipeGuard(
  options: InstallIosStandaloneBackSwipeGuardOptions = {},
): () => void {
  const targetWindow = options.window ?? (typeof window === "undefined" ? undefined : window);
  if (!targetWindow) {
    return () => {};
  }

  const environment = {
    isStandalonePwa: options.isStandalonePwa?.() ?? isStandalonePwa(),
    maxTouchPoints: targetWindow.navigator.maxTouchPoints ?? 0,
    platform: targetWindow.navigator.platform ?? "",
    userAgent: targetWindow.navigator.userAgent ?? "",
  };

  if (!shouldInstallIosStandaloneBackSwipeGuard(environment)) {
    return () => {};
  }

  const onTouchStart = (event: TouchEvent) => {
    if (
      shouldPreventIosHistorySwipeTouchStart({
        cancelable: event.cancelable,
        clientX: getFirstTouchClientX(event.touches),
        defaultPrevented: event.defaultPrevented,
        touchCount: event.touches.length,
        viewportWidth: getViewportWidth(targetWindow),
      })
    ) {
      event.preventDefault();
    }
  };

  targetWindow.addEventListener("touchstart", onTouchStart, {
    capture: true,
    passive: false,
  });

  return () => {
    targetWindow.removeEventListener("touchstart", onTouchStart, true);
  };
}

function getFirstTouchClientX(touches: TouchList): number | null {
  const firstTouch = touches.item(0);
  return typeof firstTouch?.clientX === "number" ? firstTouch.clientX : null;
}

function getViewportWidth(targetWindow: Window): number {
  return targetWindow.innerWidth || targetWindow.document.documentElement.clientWidth || 0;
}
