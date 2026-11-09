import { useNavigate, type AnyRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";

import { GUEST_PAGE_PATH } from "../../guestPage";
import { withoutAssistantCitationHash } from "../../lib/assistantCitationNavigation";

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

/** Remembers where Settings, Usage, and the utility pages lead back to. */
export function startMainAppLocationTracking(router: AnyRouter): () => void {
  const record = () => {
    const { pathname } = router.state.location;
    if (isAppModalPage(pathname) || SHELL_LESS_PATHS.has(pathname)) return;
    const href = withoutAssistantCitationHash(router.state.location.href);
    appModalReturnHref = href;
    if (!isSidebarUtilityPage(pathname)) mainAppHref = href;
  };
  record();
  return router.subscribe("onResolved", record);
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}

/** The pages that open as a modal, or in place of the thread through a plugin's page frame. */
export type AppPage = "settings" | "usage";

/** The page a plugin's page frame shows in place of the thread, else null. */
export const shownAppPageAtom = Atom.make<AppPage | null>(null).pipe(Atom.keepAlive);

/** Whether the sidebar shows a Back button, which makes a page's own close button redundant. */
export const sidebarBackShownAtom = Atom.make(false).pipe(Atom.keepAlive);

/** Whether the sidebar lists Settings' sections in place of the threads. */
export const sidebarSettingsNavShownAtom = Atom.make(false).pipe(Atom.keepAlive);

/** Leaves Settings or Usage for the page that opened it. */
export function useCloseAppModal() {
  const navigate = useNavigate();
  return () => {
    // Leaving unmounts a focused field without a blur, so commit-on-blur rows would drop what
    // was typed. Blur first so they commit.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest("[data-app-modal]")) focused.blur();
    return navigate({ href: appModalReturnHref ?? mainAppHref ?? "/" });
  };
}
