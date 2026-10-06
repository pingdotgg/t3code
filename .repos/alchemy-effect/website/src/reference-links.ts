import redirects from "./generated/reference-redirects.json";

const referenceRedirects: Record<string, string> = redirects;

/** Shared by the Worker and build output so links and redirects stay in sync. */
export function referenceDestination(href: string): string | undefined {
  const url = new URL(href, "https://alchemy.run");
  let pathname = url.pathname.replace(/\/$/, "");
  const markdown = pathname.endsWith(".md");
  if (markdown) pathname = pathname.slice(0, -3);
  const target = referenceRedirects[pathname];
  if (!target) return undefined;
  const [page, resource] = target.split("#");
  if (markdown) return `${page}.md${url.search}`;
  const anchor = url.hash ? `${resource}-${url.hash.slice(1)}` : resource;
  return `${page}${url.search}#${anchor}`;
}

/** Rewrite authored links without rewriting the hand-maintained guide sources. */
export function rewriteReferenceLinks(source: string): string {
  return source.replace(
    /(?:href=["']|\]\()(\/providers\/[^\s"'<>)]*)/g,
    (match, href: string) =>
      match.replace(href, referenceDestination(href) ?? href),
  );
}
