import { GUEST_PAGE_PATH } from "@t3tools/contracts";

/** Whether this is the page a guest link opens: one shared thread, with no T3 session. */
export function isGuestPage(): boolean {
  return window.location.pathname === GUEST_PAGE_PATH;
}
