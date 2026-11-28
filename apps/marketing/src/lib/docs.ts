import { type CollectionEntry, getCollection } from "astro:content";

import { type DocNavGroup, type DocNavItem, extractDocMeta, parseDocsIndex } from "./docsMarkdown";
import { GITHUB_REPOSITORY_URL } from "./site";

export interface ResolvedDoc {
  readonly id: string;
  readonly slug: string | null;
  readonly href: string;
  readonly rawHref: string;
  readonly githubUrl: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly entry: CollectionEntry<"docs">;
}

export interface DocsCatalog {
  readonly indexDoc: ResolvedDoc;
  readonly docs: ReadonlyArray<ResolvedDoc>;
  readonly bySlug: ReadonlyMap<string, ResolvedDoc>;
  readonly groups: ReadonlyArray<DocNavGroup>;
  readonly orderedItems: ReadonlyArray<DocNavItem>;
}

let cachedCatalog: Promise<DocsCatalog> | null = null;

async function buildDocsCatalog(): Promise<DocsCatalog> {
  const entries = await getCollection("docs");
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const readmeEntry = entryById.get("README");
  if (!readmeEntry) {
    throw new Error("Expected docs/user/README.md to exist in the docs collection.");
  }

  const parsedGroups = parseDocsIndex(readmeEntry.body ?? "");
  const categoryBySlug = new Map<string, string>();
  const labelBySlug = new Map<string, string>();
  const orderedItems: DocNavItem[] = [];
  const validGroups: DocNavGroup[] = [];

  for (const group of parsedGroups) {
    const items = group.items.filter((item) => entryById.has(item.slug));
    if (items.length === 0) continue;
    validGroups.push({ category: group.category, items });
    for (const item of items) {
      categoryBySlug.set(item.slug, group.category);
      labelBySlug.set(item.slug, item.label);
      orderedItems.push(item);
    }
  }

  // Include any docs/user/*.md not yet listed in README.md so nothing is orphaned.
  const unlistedItems: DocNavItem[] = [];
  for (const entry of entries) {
    if (entry.id === "README" || categoryBySlug.has(entry.id)) continue;
    const meta = extractDocMeta(entry.body ?? "", entry.id);
    unlistedItems.push({ slug: entry.id, label: meta.title, summary: meta.description });
    categoryBySlug.set(entry.id, "More");
    labelBySlug.set(entry.id, meta.title);
    orderedItems.push({ slug: entry.id, label: meta.title, summary: meta.description });
  }
  if (unlistedItems.length > 0) {
    unlistedItems.sort((a, b) => a.label.localeCompare(b.label));
    validGroups.push({ category: "More", items: unlistedItems });
  }

  const readmeMeta = extractDocMeta(readmeEntry.body ?? "", "T3 Code User Guide");
  const indexDoc: ResolvedDoc = {
    id: "README",
    slug: null,
    href: "/docs",
    rawHref: "/docs/index.md",
    githubUrl: `${GITHUB_REPOSITORY_URL}/blob/main/docs/user/README.md`,
    title: readmeEntry.data.title ?? readmeMeta.title,
    description: readmeEntry.data.description ?? readmeMeta.description,
    category: "Overview",
    entry: readmeEntry,
  };

  const docs: ResolvedDoc[] = [];
  const bySlug = new Map<string, ResolvedDoc>();

  for (const item of orderedItems) {
    const entry = entryById.get(item.slug);
    if (!entry) continue;
    const meta = extractDocMeta(entry.body ?? "", item.slug);
    const resolved: ResolvedDoc = {
      id: entry.id,
      slug: item.slug,
      href: `/docs/${item.slug}`,
      rawHref: `/docs/${item.slug}.md`,
      githubUrl: `${GITHUB_REPOSITORY_URL}/blob/main/docs/user/${entry.id}.md`,
      title: entry.data.title ?? meta.title ?? labelBySlug.get(item.slug) ?? item.slug,
      description: entry.data.description ?? meta.description,
      category: categoryBySlug.get(item.slug) ?? "Guides",
      entry,
    };
    docs.push(resolved);
    bySlug.set(item.slug, resolved);
  }

  return {
    indexDoc,
    docs,
    bySlug,
    groups: validGroups,
    orderedItems,
  };
}

export function getDocsCatalog(): Promise<DocsCatalog> {
  if (!cachedCatalog) {
    cachedCatalog = buildDocsCatalog();
  }
  return cachedCatalog;
}

export function getPrevNext(
  catalog: DocsCatalog,
  currentSlug: string | null,
): { readonly prev: ResolvedDoc | null; readonly next: ResolvedDoc | null } {
  if (currentSlug === null) {
    return { prev: null, next: catalog.docs[0] ?? null };
  }
  const index = catalog.docs.findIndex((doc) => doc.slug === currentSlug);
  if (index === -1) return { prev: null, next: null };
  return {
    prev: index === 0 ? catalog.indexDoc : (catalog.docs[index - 1] ?? null),
    next: catalog.docs[index + 1] ?? null,
  };
}
