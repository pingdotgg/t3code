import {
  createNavigationContainerRef,
  type NavigationAction,
  type NavigationContainerRef,
  type NavigationState,
} from "@react-navigation/native";

import { activeAppWindowId, subscribeAppWindows, type AppWindowId } from "./appWindows";

type RootNavigation = NavigationContainerRef<ReactNavigation.RootParamList>;

/**
 * The navigation container of the window in use. Work that outlives a screen (a
 * draft route's branch checkout, notification taps, quick actions, Connect
 * onboarding) navigates through it instead of mounting hooks in the navigator.
 * Every window has a container of its own; this ref follows the active one.
 */
export const rootNavigationRef = createNavigationContainerRef<ReactNavigation.RootParamList>();

// In attach order: the newest stands in while its window is not registered yet.
const containers = new Map<AppWindowId, RootNavigation>();

function retarget() {
  const active = activeAppWindowId();
  rootNavigationRef.current =
    (active === null ? undefined : containers.get(active)) ??
    [...containers.values()].at(-1) ??
    null;
}
subscribeAppWindows(retarget);

/**
 * Ref callback for a window's container. Android activity replacement mounts the
 * new root before the old one unmounts, so the old container must not clear the
 * ref the new one already owns.
 */
export function attachRootNavigation(
  windowId: AppWindowId,
  navigation: RootNavigation | null,
): () => void {
  if (navigation) {
    containers.delete(windowId);
    containers.set(windowId, navigation);
  }
  retarget();
  return () => {
    if (containers.get(windowId) === navigation) containers.delete(windowId);
    retarget();
  };
}

/** Whether app-wide navigation, such as an opened link, currently goes to this window. */
export function isRootNavigationWindow(windowId: AppWindowId): boolean {
  const container = containers.get(windowId);
  return container !== undefined && container === rootNavigationRef.current;
}

/** The root routes of every window, for state that lives as long as any window shows it. */
export function rootNavigationRoutes(): { readonly routes: NavigationState["routes"] } {
  return {
    routes: [...containers.values()].flatMap((container) =>
      container.isReady() ? (container.getRootState()?.routes ?? []) : [],
    ),
  };
}

const pendingUntilReady: Array<() => void> = [];

/** Runs `navigate` now if the container is ready, otherwise once it becomes ready. */
export function whenRootNavigationReady(navigate: () => void): void {
  if (rootNavigationRef.isReady()) {
    navigate();
    return;
  }
  pendingUntilReady.push(navigate);
}

/** Wired to every container's `onReady`; the queue waits for the one in use. */
export function flushRootNavigationQueue(): void {
  if (!rootNavigationRef.isReady()) return;
  for (const navigate of pendingUntilReady.splice(0)) {
    try {
      navigate();
    } catch (error) {
      console.error("[navigation] queued navigation failed", error);
    }
  }
}

/**
 * `useLinkTo` for app services that live outside the navigator: the same
 * leading-'/' guard, then the href's action dispatched at the root once ready.
 */
export function linkToRootPath(href: string, toAction: (href: string) => NavigationAction): void {
  if (!href.startsWith("/")) throw new Error(`The href must start with '/' (${href}).`);
  whenRootNavigationReady(() => {
    rootNavigationRef.dispatch({
      target: rootNavigationRef.getRootState()?.key,
      ...toAction(href),
    });
  });
}
