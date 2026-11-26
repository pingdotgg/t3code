/** The page a guest link opens. It shows one shared thread to a browser with no T3 session. */
export const GUEST_PAGE_PATH = "/guest";

export function normalizeRoutePathname(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

export function isGuestPage(pathname: string = window.location.pathname): boolean {
  return normalizeRoutePathname(pathname) === GUEST_PAGE_PATH;
}
