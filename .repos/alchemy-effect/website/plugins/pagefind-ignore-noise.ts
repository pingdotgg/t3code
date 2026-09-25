/** Add search exclusions during the shared build-output pass. */
// Selectors (matched as opening-tag class strings) we want Pagefind to
// skip. We add the attribute as `data-pagefind-ignore="all"` so any
// headings inside also stop being indexed (otherwise headings inside a
// collapsed code block would still show up as sub-results).
const classMatchers = [
  // Expressive Code wraps every fenced code block in this div.
  "expressive-code",
  // Starlight's TOC, sidebar, page footer, pagination, header.
  "right-sidebar",
  "sidebar-pane",
  "sl-sidebar-state-persist",
  "pagination-links",
  "sl-mobile-toc",
  "site-search",
];
const classRegex = new RegExp(
  `<(div|nav|aside|figure|header|footer|details|site-search)([^>]*?)class="([^"]*?\\b(?:${classMatchers.join("|")})\\b[^"]*?)"([^>]*?)>`,
  "g",
);
// Also tag every <pre> directly, which catches the inner code element
// even if Expressive Code wrapping ever changes.
const preRegex = /<pre(\s[^>]*)?>/g;
// Provider docs auto-generated from JSDoc start with a
// "> **Source:** `src/...`" blockquote that's noise for search excerpts.
const sourceBlockquoteRegex =
  /<blockquote>\s*<p><strong>Source:<\/strong>[\s\S]*?<\/p>\s*<\/blockquote>/g;

export function rewriteForPagefind(html: string) {
  let out = html.replace(classRegex, (match, tag, pre, cls, post) => {
    if (match.includes("data-pagefind-ignore")) return match;
    return `<${tag}${pre}class="${cls}" data-pagefind-ignore="all"${post}>`;
  });
  out = out.replace(preRegex, (match, attrs = "") => {
    if (match.includes("data-pagefind-ignore")) return match;
    return `<pre${attrs} data-pagefind-ignore="all">`;
  });
  out = out.replace(sourceBlockquoteRegex, (match) =>
    match.replace("<blockquote>", '<blockquote data-pagefind-ignore="all">'),
  );
  return out;
}
