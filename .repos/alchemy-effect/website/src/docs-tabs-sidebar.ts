/// <reference types="@astrojs/starlight/locals" />
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import type { StarlightRouteData } from "@astrojs/starlight/route-data";
import { activeTab } from "./docs-tabs";

type SidebarItem = StarlightRouteData["sidebar"][number];
type SidebarLink = Extract<SidebarItem, { type: "link" }>;

/**
 * The config sidebar in `astro.config.mjs` is one top-level group per docs
 * tab (see `docs-tabs.ts`). This middleware swaps the whole-site sidebar for
 * just the active tab's entries so the sidebar only ever navigates within
 * the current tab, and recomputes prev/next pagination so it never walks
 * across a tab boundary.
 *
 * Blog routes are skipped — starlight-blog owns their sidebar (re-bucketed
 * by `blog-sidebar.ts`).
 */
export const onRequest = defineRouteMiddleware(async (context, next) => {
  await next();

  const pathname = context.url.pathname;
  if (pathname === "/blog" || pathname.startsWith("/blog/")) return;

  const { starlightRoute } = context.locals;
  const tab = activeTab(pathname);
  const group = starlightRoute.sidebar.find(
    (item): item is Extract<SidebarItem, { type: "group" }> =>
      item.type === "group" && item.label === tab.label,
  );
  if (!group) return;

  starlightRoute.sidebar = group.entries;

  const links = flattenLinks(group.entries);
  const index = links.findIndex((link) => link.isCurrent);
  const { prev, next: nextLink } = starlightRoute.entry.data;
  starlightRoute.pagination = {
    prev: override(prev, index > 0 ? links[index - 1] : undefined),
    next: override(nextLink, index !== -1 ? links[index + 1] : undefined),
  };
});

/**
 * Apply a page's `prev` / `next` frontmatter to the sidebar-derived link, the
 * same way Starlight's own pagination does: `false` removes the link, a
 * string relabels it, and `{ link, label }` replaces it outright.
 */
function override(
  config: StarlightRouteData["entry"]["data"]["prev"],
  link: SidebarLink | undefined,
): SidebarLink | undefined {
  if (config === undefined || config === true) return link;
  if (config === false) return undefined;
  if (typeof config === "string") {
    return link ? { ...link, label: config } : undefined;
  }
  const href = config.link ?? link?.href;
  const label = config.label ?? link?.label;
  if (!href || !label) return link;
  return {
    type: "link",
    label,
    href,
    isCurrent: false,
    badge: undefined,
    attrs: {},
  };
}

function flattenLinks(items: SidebarItem[]): SidebarLink[] {
  const links: SidebarLink[] = [];
  for (const item of items) {
    if (item.type === "link") links.push(item);
    else links.push(...flattenLinks(item.entries));
  }
  return links;
}
