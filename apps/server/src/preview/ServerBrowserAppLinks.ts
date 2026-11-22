import { appLinkUrl } from "@t3tools/shared/appLinks";
import type { CDPSession } from "playwright-core";

export interface AppLinkRequest {
  readonly url: string;
  /** The page asked for a new window, which headless Chromium still opens and leaves empty. */
  readonly opensWindow: boolean;
}

/**
 * Headless Chromium aborts navigations to app links such as `obsidian:` or `t3-thread:`, so the
 * page's own session is the only place to see them. Needs the session's Page domain enabled.
 */
export function watchAppLinks(cdp: CDPSession, onAppLink: (request: AppLinkRequest) => void) {
  cdp.on("Page.frameRequestedNavigation", ({ url, disposition }) => {
    const link = disposition === "currentTab" ? appLinkUrl(url) : null;
    if (link !== null) onAppLink({ url: link, opensWindow: false });
  });
  cdp.on("Page.windowOpen", ({ url }) => {
    const link = appLinkUrl(url);
    if (link !== null) onAppLink({ url: link, opensWindow: true });
  });
}
