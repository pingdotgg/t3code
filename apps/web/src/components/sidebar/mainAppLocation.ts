import { useLocation, useNavigate, type AnyRouter } from "@tanstack/react-router";

import { GUEST_PAGE_PATH } from "../../guestPage";
import { withoutAssistantCitationHash } from "../../lib/assistantCitationNavigation";

/** Settings and Usage open as modals over the last main-app view. */
export function isAppModalPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/usage";
}

export function isAgentsPage(pathname: string) {
  return pathname === "/agents" || pathname.startsWith("/agents/");
}

/** The two ways to work: the Agents board, or the thread list and its chats. */
export type WorkspaceView = "agents" | "threads";

// Kept per window, so a reload on a utility page still returns to the view
// (and the chat) it was opened from.
const STORAGE_KEY = "t3code:main-app-location";

interface MainAppLocation {
  /** The latest main app URL, which a utility page's Back returns to. */
  href: string | null;
  view: WorkspaceView;
  /** The latest URL in each view, which switching views returns to. */
  hrefByView: Record<WorkspaceView, string | null>;
}

function readStoredLocation(): MainAppLocation {
  const empty: MainAppLocation = {
    href: null,
    view: "threads",
    hrefByView: { agents: null, threads: null },
  };
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    return stored ? { ...empty, ...(JSON.parse(stored) as Partial<MainAppLocation>) } : empty;
  } catch {
    return empty;
  }
}

let location: MainAppLocation | null = null;
const current = () => (location ??= readStoredLocation());

function store(next: MainAppLocation) {
  location = next;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; the in-memory location still works.
  }
}

/**
 * Records that a chat opened on the thread route is shown in the threads view.
 * The route alone cannot tell: an agent chat opened there from the Agents view
 * moves to the Agents board instead.
 */
export function enterThreadsView(href: string) {
  store({ ...current(), view: "threads", hrefByView: { ...current().hrefByView, threads: href } });
}

export function readWorkspaceView(): WorkspaceView {
  return current().view;
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
    if (!isSidebarUtilityPage(pathname)) {
      mainAppHref = href;
      const previous = current();
      const view = isAgentsPage(pathname)
        ? "agents"
        : /^\/[^/]+\/[^/]+$/.test(pathname) && !pathname.startsWith("/draft/")
          ? null
          : "threads";
      store({
        href,
        view: view ?? previous.view,
        hrefByView: view ? { ...previous.hrefByView, [view]: href } : previous.hrefByView,
      });
    }
  };
  record();
  return router.subscribe("onResolved", record);
}

/** The main app URL a utility page returns to: the last one visited, else the thread list. */
function readMainAppHref(): string {
  return current().href ?? "/";
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: readMainAppHref() });
}

/** Switches between the Agents board and the threads view, back to where each was left. */
export function useToggleWorkspaceView() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (target?: WorkspaceView) => {
    const onAgents =
      isAgentsPage(pathname) ||
      ((isSidebarUtilityPage(pathname) || isAppModalPage(pathname)) &&
        readWorkspaceView() === "agents");
    const view = target ?? (onAgents ? "threads" : "agents");
    // Set first: a thread route reads the view to decide where an agent chat belongs.
    store({ ...current(), view });
    return navigate({
      href: current().hrefByView[view] ?? (view === "agents" ? "/agents" : "/"),
    });
  };
}

/** Leaves Settings or Usage for the page that opened it. */
export function useCloseAppModal() {
  const navigate = useNavigate();
  return () => navigate({ href: appModalReturnHref ?? mainAppHref ?? "/" });
}
