import * as NodePath from "node:path";

import { GITHUB_REPOSITORY_URL } from "./site.ts";

export interface DocMeta {
  readonly title: string;
  readonly description: string;
}

export interface DocNavItem {
  readonly slug: string;
  readonly label: string;
  readonly summary: string;
}

export interface DocNavGroup {
  readonly category: string;
  readonly items: ReadonlyArray<DocNavItem>;
}

const stripInlineMarkdown = (input: string): string =>
  input
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Rewrites repo-relative markdown links from `docs/user/*.md` into `/docs/...` routes
 * (or GitHub blob URLs for links that point outside `docs/user/`).
 */
export function rewriteDocLink(href: string): string {
  const trimmed = href.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
  ) {
    return href;
  }

  const hashIndex = trimmed.indexOf("#");
  const rawPath = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : trimmed.slice(hashIndex);

  if (!rawPath) return href;

  const normalized = NodePath.posix.normalize(NodePath.posix.join("docs/user", rawPath));

  if (normalized.startsWith("docs/user/") && normalized.endsWith(".md")) {
    const filename = normalized.slice("docs/user/".length);
    if (!filename.includes("/")) {
      const slug = filename.slice(0, -".md".length);
      if (slug.toLowerCase() === "readme") {
        return `/docs${hash}`;
      }
      return `/docs/${slug}${hash}`;
    }
  }

  return `${GITHUB_REPOSITORY_URL}/blob/main/${normalized}${hash}`;
}

/**
 * Prepares a raw `docs/user/*.md` file for web rendering:
 * - Strips the first top-level `# H1` so the page template owns the single `<h1>`.
 * - Rewrites relative Markdown links (outside fenced code blocks and inline code) to `/docs/...`.
 */
export function preprocessDocMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let inCodeFence = false;
  let strippedH1 = false;

  const rewriteLineLinks = (line: string): string => {
    // Rewrite reference-style link definitions: `[id]: ./foo.md`
    const defMatch = /^(\s*\[[^\]]+\]:\s*)(\S+)(.*)$/.exec(line);
    if (defMatch) {
      return `${defMatch[1]}${rewriteDocLink(defMatch[2]!)}${defMatch[3]}`;
    }

    // Rewrite inline links outside backtick code spans.
    const segments = line.split(/(`[^`]*`)/g);
    return segments
      .map((segment, index) => {
        if (index % 2 === 1) return segment;
        return segment.replace(/(!?\[[^\]]*\]\()([^)\s]+)([^)]*\))/g, (_m, open, url, close) => {
          return `${open}${rewriteDocLink(url)}${close}`;
        });
      })
      .join("");
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      out.push(line);
      continue;
    }
    if (inCodeFence) {
      out.push(line);
      continue;
    }
    if (!strippedH1 && /^#\s+.+$/.test(trimmed)) {
      strippedH1 = true;
      continue;
    }
    out.push(rewriteLineLinks(line));
  }

  return out.join("\n").replace(/^\n+/, "");
}

/** Extracts title (first `# H1`) and description (first plain paragraph) from markdown. */
export function extractDocMeta(markdown: string, fallbackSlug: string): DocMeta {
  const lines = markdown.split(/\r?\n/);
  let title = fallbackSlug.replace(/-/g, " ");
  let titleLineIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const match = /^#\s+(.+)$/.exec(lines[i]!.trim());
    if (match) {
      title = stripInlineMarkdown(match[1]!);
      titleLineIndex = i;
      break;
    }
  }

  const paragraphLines: string[] = [];
  let inCodeFence = false;
  for (let i = titleLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (!line) {
      if (paragraphLines.length > 0) break;
      continue;
    }
    if (
      line.startsWith("#") ||
      line.startsWith("|") ||
      line.startsWith(">") ||
      line.startsWith("- ") ||
      line.startsWith("* ") ||
      /^\d+\.\s/.test(line)
    ) {
      if (paragraphLines.length > 0) break;
      continue;
    }
    paragraphLines.push(line);
  }

  const description =
    paragraphLines.length > 0
      ? stripInlineMarkdown(paragraphLines.join(" "))
      : `${title}: T3 Code documentation.`;

  return { title, description };
}

/**
 * Parses the `## Documentation index` section of `docs/user/README.md` into ordered
 * sidebar groups so the website navigation stays in sync with the repo index.
 */
export function parseDocsIndex(readmeMarkdown: string): ReadonlyArray<DocNavGroup> {
  const lines = readmeMarkdown.split(/\r?\n/);
  const groups: Array<{ category: string; items: DocNavItem[] }> = [];
  let inIndex = false;
  let currentGroup: { category: string; items: DocNavItem[] } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^##\s+Documentation index$/i.test(line)) {
      inIndex = true;
      continue;
    }
    if (!inIndex) continue;
    if (/^##\s+/.test(line)) break;

    const categoryMatch = /^###\s+(.+)$/.exec(line);
    if (categoryMatch) {
      currentGroup = { category: categoryMatch[1]!.trim(), items: [] };
      groups.push(currentGroup);
      continue;
    }

    if (!currentGroup) continue;
    const itemMatch = /^-\s+\[([^\]]+)\]\(\.\/([^)#]+)\.md(?:#[^)]*)?\)\s*(?:[—–-]\s*(.+))?$/.exec(
      line,
    );
    if (itemMatch) {
      currentGroup.items.push({
        label: stripInlineMarkdown(itemMatch[1]!),
        slug: itemMatch[2]!.trim(),
        summary: itemMatch[3] ? stripInlineMarkdown(itemMatch[3]) : "",
      });
    }
  }

  return groups;
}
