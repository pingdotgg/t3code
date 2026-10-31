import {
  defaultParseSearch,
  defaultStringifySearch,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { createContext, use } from "react";

import {
  findLayoutTabByContent,
  isLayoutPageContent,
  type LayoutPageContent,
  type LayoutTabDestination,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { readPullRequestListPreferences } from "../components/pullRequest/pullRequestListPreferences";

export function layoutPageKind(pathname: string): LayoutPageContent["kind"] | null {
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/usage") return "usage";
  if (pathname === "/pull-requests") return "pull-requests";
  return null;
}

export function layoutPageHref(content: LayoutPageContent): string {
  const href =
    content.href ?? (content.kind === "settings" ? "/settings/general" : `/${content.kind}`);
  const url = new URL(href, "http://t3.invalid");
  if (content.href === undefined && content.kind === "pull-requests") {
    url.search = defaultStringifySearch(readPullRequestListPreferences());
  }
  if (content.kind === "pull-requests") url.searchParams.set("pane", "1");
  else url.searchParams.delete("pane");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function parseLayoutPageLocation(content: LayoutPageContent) {
  const href = layoutPageHref(content);
  const url = new URL(href, "http://t3.invalid");
  return {
    href,
    pathname: url.pathname,
    hash: url.hash.slice(1),
    search: defaultParseSearch(url.search),
  };
}

export const LayoutPageLocationContext = createContext<ReturnType<
  typeof parseLayoutPageLocation
> | null>(null);

/** Page tabs read their own URL even while another pane holds the browser URL. */
export function useLayoutPageLocation(): {
  href: string;
  pathname: string;
  hash: string;
  search: Record<string, unknown>;
} {
  const location = useLocation();
  return use(LayoutPageLocationContext) ?? location;
}

/** The new-tab launcher opts into a page tab in its own pane. */
export function useOpenLayoutPage() {
  const navigate = useNavigate();
  return (
    kind: LayoutPageContent["kind"],
    destination?: LayoutTabDestination,
    replaceTabId?: string,
  ) => {
    if (kind === "settings" || kind === "usage") {
      return navigate({ href: layoutPageHref({ kind }) });
    }
    const store = useLayoutStore.getState();
    const existing = findLayoutTabByContent(store.layout, { kind });
    if (existing) {
      if (replaceTabId && replaceTabId !== existing.tab.id) store.closeTab(replaceTabId);
      store.focusTab(existing.tab.id);
    } else if (replaceTabId) store.replaceTabContent(replaceTabId, { kind });
    else if (destination) store.placeContent({ kind }, destination);
    else store.openTab({ kind });
    const content = findLayoutTabByContent(useLayoutStore.getState().layout, { kind })?.tab.content;
    return navigate({
      href: layoutPageHref(content && isLayoutPageContent(content) ? content : { kind }),
    });
  };
}
