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
const groupOrder: BlogCategory[] = ["post", "release"];

interface BlogMeta {
  category: BlogCategory;
  date: Date | undefined;
}

let metaById: Map<string, BlogMeta> | undefined;

async function loadMetaById(): Promise<Map<string, BlogMeta>> {
  if (metaById) return metaById;
  const entries = await getCollection("docs", (entry) => entry.id.startsWith("blog/"));
  const map = new Map<string, BlogMeta>();
  for (const entry of entries) {
    const data = entry.data as { category?: BlogCategory; date?: Date };
    map.set(entry.id, { category: data.category ?? "post", date: data.date });
  }
  metaById = map;
  return map;
}

// Release titles lead with the version ("2.0.0-beta.80 - GCP, …"), which
// truncates the descriptive part in the narrow sidebar. Lead with the
// release date instead; the page itself keeps the versioned title.
function releaseLabel(label: string, date: Date | undefined): string {
  if (!date) return label;
  const title = label.replace(/^\S+\s+-\s+/, "");
  return `${date.toISOString().slice(0, 10)} · ${title}`;
}

function extractBlogId(href: string): string | undefined {
  const match = href.match(/\/blog\/([^/]+)\/?$/);
  return match ? `blog/${match[1]}` : undefined;
}

export const onRequest = defineRouteMiddleware(async (context, next) => {
  await next();

  // TODO: fix types
  const { starlightRoute, t } = context.locals as Record<string, any>;
  const recentLabel = t("starlightBlog.sidebar.recent");

  const recentIndex = starlightRoute.sidebar.findIndex(
    (item: any): item is SidebarGroup => item.type === "group" && item.label === recentLabel,
  );
  if (recentIndex === -1) return;

  const recentGroup = starlightRoute.sidebar[recentIndex] as SidebarGroup;
  const metas = await loadMetaById();

  const buckets = new Map<BlogCategory, SidebarItem[]>();
  for (const category of groupOrder) buckets.set(category, []);

  for (const item of recentGroup.entries) {
    if (item.type !== "link") continue;
    const id = extractBlogId(item.href);
    const meta = id !== undefined ? metas.get(id) : undefined;
    const category: BlogCategory = meta?.category ?? "post";
    buckets
      .get(category)!
      .push(
        category === "release" ? { ...item, label: releaseLabel(item.label, meta?.date) } : item,
      );
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
