/// <reference types="@astrojs/starlight/locals" />
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import type { StarlightRouteData } from "@astrojs/starlight/route-data";
import { getCollection } from "astro:content";
import type { BlogCategory } from "./content.config";

type SidebarItem = StarlightRouteData["sidebar"][number];
type SidebarGroup = Extract<SidebarItem, { type: "group" }>;

const groupLabels: Record<BlogCategory, string> = {
  release: "Releases",
  post: "Posts",
};
const groupOrder: BlogCategory[] = ["release", "post"];

let categoryById: Map<string, BlogCategory> | undefined;

async function loadCategoryById(): Promise<Map<string, BlogCategory>> {
  if (categoryById) return categoryById;
  const entries = await getCollection("docs", (entry) =>
    entry.id.startsWith("blog/"),
  );
  const map = new Map<string, BlogCategory>();
  for (const entry of entries) {
    const data = entry.data as { category?: BlogCategory };
    map.set(entry.id, data.category ?? "post");
  }
  categoryById = map;
  return map;
}

function extractBlogId(href: string): string | undefined {
  const match = href.match(/\/blog\/([^/]+)\/?$/);
  return match ? `blog/${match[1]}` : undefined;
}

export const onRequest = defineRouteMiddleware(async (context, next) => {
  await next();

  const { starlightRoute, t } = context.locals;
  const recentLabel = t("starlightBlog.sidebar.recent");

  const recentIndex = starlightRoute.sidebar.findIndex(
    (item): item is SidebarGroup =>
      item.type === "group" && item.label === recentLabel,
  );
  if (recentIndex === -1) return;

  const recentGroup = starlightRoute.sidebar[recentIndex] as SidebarGroup;
  const categories = await loadCategoryById();

  const buckets = new Map<BlogCategory, SidebarItem[]>();
  for (const category of groupOrder) buckets.set(category, []);

  for (const item of recentGroup.entries) {
    if (item.type !== "link") continue;
    const id = extractBlogId(item.href);
    const category: BlogCategory =
      (id !== undefined ? categories.get(id) : undefined) ?? "post";
    buckets.get(category)!.push(item);
  }

  const replacement: SidebarGroup[] = [];
  for (const category of groupOrder) {
    const entries = buckets.get(category)!;
    if (entries.length === 0) continue;
    replacement.push({
      type: "group",
      label: groupLabels[category],
      entries,
      collapsed: false,
      badge: undefined,
    });
  }

  starlightRoute.sidebar.splice(recentIndex, 1, ...replacement);
});
