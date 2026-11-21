import type { Root } from "mdast";

const MAX_AST_ENTRIES = 192;
const MAX_RENDERED_ENTRIES = 256;
const MAX_CACHEABLE_LENGTH = 131_072;

const astCache = new Map<string, Root>();
const renderedMarkdownCache = new Map<string, string>();
const linkUrlsCache = new Map<string, readonly string[]>();

export const EMPTY_FILE_HREFS: ReadonlySet<string> = new Set<string>();
export const EMPTY_LINK_URLS: readonly string[] = [];

const LINK_CANDIDATE_RE = /(?:\]\(|\]\[|\]:|https?:\/\/|www\.|mailto:|t3-|<[a-z][a-z0-9+.-]*:)/i;

function hasEmailCandidate(markdown: string): boolean {
  let at = markdown.indexOf("@");
  while (at !== -1) {
    if (
      at > 0 &&
      at + 1 < markdown.length &&
      !/[\s@]/.test(markdown[at - 1]!) &&
      !/[\s@]/.test(markdown[at + 1]!)
    ) {
      return true;
    }
    at = markdown.indexOf("@", at + 1);
  }
  return false;
}

interface MdastNodeLike {
  readonly type: string;
  readonly url?: string;
  readonly identifier?: string;
  readonly children?: ReadonlyArray<MdastNodeLike>;
}

function lruGet<V>(cache: Map<string, V>, key: string): V | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function lruSet<V>(cache: Map<string, V>, key: string, value: V, maxEntries: number): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

export function getCachedMarkdownAst(markdown: string, parse: (input: string) => Root): Root {
  if (markdown.length > MAX_CACHEABLE_LENGTH) return parse(markdown);
  const hit = lruGet(astCache, markdown);
  if (hit !== undefined) return hit;
  const parsed = parse(markdown);
  lruSet(astCache, markdown, parsed, MAX_AST_ENTRIES);
  return parsed;
}

export function getCachedNativeMarkdown(
  markdown: string,
  compute: (input: string) => string,
): string {
  if (markdown.length > MAX_CACHEABLE_LENGTH) return compute(markdown);
  const hit = lruGet(renderedMarkdownCache, markdown);
  if (hit !== undefined) return hit;
  const rendered = compute(markdown);
  lruSet(renderedMarkdownCache, markdown, rendered, MAX_RENDERED_ENTRIES);
  return rendered;
}

// Seeds EnrichedMarkdownText linkVariants/linkPillContent on render 1 so Android does not
// recreate all native segment views after useLayoutEffect reports onLinksChange.
export function getCachedMarkdownLinkUrls(
  markdown: string,
  parse: (input: string) => Root,
): readonly string[] {
  if (
    markdown.length === 0 ||
    (!LINK_CANDIDATE_RE.test(markdown) && !hasEmailCandidate(markdown))
  ) {
    return EMPTY_LINK_URLS;
  }
  const cacheable = markdown.length <= MAX_CACHEABLE_LENGTH;
  if (cacheable) {
    const hit = lruGet(linkUrlsCache, markdown);
    if (hit !== undefined) return hit;
  }
  const root = parse(markdown) as unknown as MdastNodeLike;
  let definitions: Map<string, string> | null = null;
  if (markdown.includes("]:")) {
    definitions = new Map<string, string>();
    const collectDefs = (node: MdastNodeLike) => {
      if (node.type === "definition" && node.identifier && typeof node.url === "string") {
        const id = node.identifier.toUpperCase();
        if (!definitions!.has(id)) definitions!.set(id, node.url);
      }
      if (node.children) {
        for (let i = 0; i < node.children.length; i++) collectDefs(node.children[i]!);
      }
    };
    collectDefs(root);
  }
  const seen = new Set<string>();
  const urls: string[] = [];
  const visit = (node: MdastNodeLike) => {
    if (node.type === "link" && typeof node.url === "string") {
      if (!seen.has(node.url)) {
        seen.add(node.url);
        urls.push(node.url);
      }
    } else if (node.type === "linkReference" && node.identifier && definitions !== null) {
      const resolved = definitions.get(node.identifier.toUpperCase());
      if (resolved !== undefined && !seen.has(resolved)) {
        seen.add(resolved);
        urls.push(resolved);
      }
    }
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) visit(node.children[i]!);
    }
  };
  visit(root);
  const result: readonly string[] = urls.length === 0 ? EMPTY_LINK_URLS : urls;
  if (cacheable) {
    lruSet(linkUrlsCache, markdown, result, MAX_RENDERED_ENTRIES);
  }
  return result;
}
