const RELATIVE_DOC_LINK = /^\.\/([\w-]+)\.md(#.*)?$/;

/** Maps a docs/user page's file name to its route id, e.g. `install.md` → `docs/install`. */
export function docsEntryId(fileName: string): string {
  const slug = fileName.replace(/\.md$/, "");
  return slug === "README" ? "docs" : `docs/${slug}`;
}

/**
 * docs/user pages link to each other as `./page.md#anchor` so they work on GitHub.
 * Rewrites those links to site routes and leaves every other link alone.
 */
export function docsHref(url: string): string {
  const match = RELATIVE_DOC_LINK.exec(url);
  if (!match) return url;
  const [, slug, hash = ""] = match;
  return `/${docsEntryId(`${slug}.md`)}/${hash}`;
}
