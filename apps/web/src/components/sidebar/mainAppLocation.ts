import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useNavigate, type AnyRouter, type ParsedLocation } from "@tanstack/react-router";

import { GUEST_PAGE_PATH } from "../../guestPage";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../../threadRoutes";

/** Settings and Usage open as modals over the last main-app view. */
export function isAppModalPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/usage";
}

export function isSidebarUtilityPage(pathname: string) {
  return pathname.startsWith("/projects/") || pathname === "/pull-requests";
}

// Pages the root route always renders without the app shell, so they are never
// a page to return to. Other paths seen before auth or on a prompt-link landing
// are still recorded; they are real app URLs, so returning to one is harmless.
const SHELL_LESS_PATHS = new Set(["/pair", "/connect", "/connect-agent", GUEST_PAGE_PATH]);

let mainAppHref: string | null = null;
let appModalReturnHref: string | null = null;
let appModalReturnTarget: ThreadRouteTarget | null = null;
const appModalReturnTargetListeners = new Set<() => void>();

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

/** Remembers where Settings, Usage, and the utility pages lead back to. */
export function startMainAppLocationTracking(router: AnyRouter): () => void {
  const isReturnPage = (pathname: string) =>
    !isAppModalPage(pathname) && !SHELL_LESS_PATHS.has(pathname);
  const record = () => {
    const { pathname, href } = router.state.location;
    if (!isReturnPage(pathname)) return;
    appModalReturnHref = href;
    if (!isSidebarUtilityPage(pathname)) mainAppHref = href;
  };
  // onResolved is skipped when another navigation starts before this one settles,
  // so the thread behind a modal follows every load as it starts instead.
  const recordTarget = ({ pathname }: ParsedLocation) => {
    if (!isReturnPage(pathname)) return;
    const target = resolveThreadRouteTarget(router.getMatchedRoutes(pathname).routeParams);
    if (threadRouteTargetKey(target) === threadRouteTargetKey(appModalReturnTarget)) return;
    appModalReturnTarget = target;
    for (const listener of appModalReturnTargetListeners) listener();
  };
  record();
  recordTarget(router.state.location);
  const stopRecord = router.subscribe("onResolved", record);
  const stopRecordTarget = router.subscribe("onBeforeLoad", (event) =>
    recordTarget(event.toLocation),
  );
  return () => {
    stopRecord();
    stopRecordTarget();
  };
}

export function subscribeAppModalReturnTarget(listener: () => void): () => void {
  appModalReturnTargetListeners.add(listener);
  return () => appModalReturnTargetListeners.delete(listener);
}

/** The thread Settings and Usage render over. */
export function getAppModalReturnTarget() {
  return appModalReturnTarget;
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}

/** Leaves Settings or Usage for the page that opened it. */
export function useCloseAppModal() {
  const navigate = useNavigate();
  return () => navigate({ href: appModalReturnHref ?? mainAppHref ?? "/" });
}
