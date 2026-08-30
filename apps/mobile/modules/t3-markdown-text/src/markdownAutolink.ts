import type { MarkdownNode } from "react-native-nitro-markdown/headless";

// md4c's MD_FLAG_PERMISSIVEAUTOLINKS refuses to linkify a bare URL that contains a
// "_" which is not flanked on both sides by ASCII alphanumerics, so paths such as
// "https://example.com/v/abc_/" survive parsing as plain text with no href. This
// transform re-scans leftover text nodes and applies GFM autolink-literal rules.

const AUTOLINK_HINT_PATTERN = /https?:\/\/|www\./i;
const AUTOLINK_START_PATTERN = /https?:\/\/|www\./gi;
const WHITESPACE_PATTERN = /\s/;
const HOST_BOUNDARY_PATTERN = /[/?#]/;

/** Node types md4c already resolved, or whose contents must never be linkified. */
const OPAQUE_NODE_TYPES: ReadonlySet<string> = new Set([
  "link",
  "image",
  "code_inline",
  "code_block",
  "html_block",
  "html_inline",
  "math_inline",
  "math_block",
]);

/** GFM: trailing punctuation is never part of an autolink literal. */
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([
  "?",
  "!",
  ".",
  ",",
  ":",
  "*",
  "_",
  "~",
  "'",
  '"',
  ";",
]);

/** GFM: an autolink may only start after whitespace or one of these delimiters. */
const OPENING_DELIMITERS: ReadonlySet<string> = new Set(["*", "_", "~", "("]);

interface AutolinkMatch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly href: string;
}

export function autolinkMarkdownUrls(node: MarkdownNode): MarkdownNode {
  if (OPAQUE_NODE_TYPES.has(node.type)) {
    return node;
  }
  const children = node.children;
  if (!children || children.length === 0) {
    return node;
  }
  const nextChildren = autolinkChildren(children);
  return nextChildren === children ? node : { ...node, children: nextChildren };
}

function autolinkChildren(children: MarkdownNode[]): MarkdownNode[] {
  let result: MarkdownNode[] | undefined;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index] as MarkdownNode;
    const split = child.type === "text" ? splitTextNode(child) : undefined;
    if (split) {
      result ??= children.slice(0, index);
      result.push(...split);
      continue;
    }
    const next = child.type === "text" ? child : autolinkMarkdownUrls(child);
    if (next !== child) {
      result ??= children.slice(0, index);
    }
    result?.push(next);
  }
  return result ?? children;
}

function splitTextNode(node: MarkdownNode): MarkdownNode[] | undefined {
  const content = node.content;
  if (!content || !AUTOLINK_HINT_PATTERN.test(content)) {
    return undefined;
  }
  const matches = findAutolinkMatches(content);
  if (matches.length === 0) {
    return undefined;
  }
  const pieces: MarkdownNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      pieces.push({ type: "text", content: content.slice(cursor, match.start) });
    }
    pieces.push({
      type: "link",
      href: match.href,
      children: [{ type: "text", content: match.text }],
    });
    cursor = match.end;
  }
  if (cursor < content.length) {
    pieces.push({ type: "text", content: content.slice(cursor) });
  }
  return pieces;
}

function findAutolinkMatches(content: string): AutolinkMatch[] {
  const matches: AutolinkMatch[] = [];
  AUTOLINK_START_PATTERN.lastIndex = 0;
  let started = AUTOLINK_START_PATTERN.exec(content);
  while (started) {
    const start = started.index;
    const prefix = started[0];
    const match = hasValidOpening(content, start)
      ? resolveAutolinkMatch(content, start, prefix)
      : undefined;
    if (match) {
      matches.push(match);
      AUTOLINK_START_PATTERN.lastIndex = match.end;
    } else {
      AUTOLINK_START_PATTERN.lastIndex = start + prefix.length;
    }
    started = AUTOLINK_START_PATTERN.exec(content);
  }
  return matches;
}

function hasValidOpening(content: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const preceding = content.charAt(index - 1);
  return WHITESPACE_PATTERN.test(preceding) || OPENING_DELIMITERS.has(preceding);
}

function resolveAutolinkMatch(
  content: string,
  start: number,
  prefix: string,
): AutolinkMatch | undefined {
  let stop = start;
  while (stop < content.length) {
    const character = content.charAt(stop);
    if (WHITESPACE_PATTERN.test(character) || character === "<") {
      break;
    }
    stop += 1;
  }
  const text = trimTrailingPunctuation(content.slice(start, stop));
  const hasScheme = prefix.toLowerCase() !== "www.";
  if (!hasPlausibleHost(text, hasScheme)) {
    return undefined;
  }
  return {
    start,
    end: start + text.length,
    text,
    href: hasScheme ? text : `http://${text}`,
  };
}

function trimTrailingPunctuation(value: string): string {
  let openParens = 0;
  let closeParens = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (character === "(") {
      openParens += 1;
    } else if (character === ")") {
      closeParens += 1;
    }
  }
  let end = value.length;
  while (end > 0) {
    const character = value.charAt(end - 1);
    if (TRAILING_PUNCTUATION.has(character)) {
      end -= 1;
      continue;
    }
    // GFM balanced-paren rule: a trailing ")" closes the autolink only when the
    // candidate has more ")" than "(", so "(https://example.com/a)" drops it but
    // "https://en.wikipedia.org/wiki/Foo_(bar)" keeps it.
    if (character === ")" && closeParens > openParens) {
      closeParens -= 1;
      end -= 1;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

function hasPlausibleHost(text: string, hasScheme: boolean): boolean {
  const schemeEnd = hasScheme ? text.indexOf("://") : -1;
  if (hasScheme && schemeEnd === -1) {
    return false;
  }
  const authority = hasScheme ? text.slice(schemeEnd + 3) : text;
  const boundary = authority.search(HOST_BOUNDARY_PATTERN);
  const host = boundary === -1 ? authority : authority.slice(0, boundary);
  if (host.length === 0) {
    return false;
  }
  if (hasScheme) {
    // Developer tooling links at dotless hosts such as http://localhost:3000 are common.
    return true;
  }
  const lastDot = host.lastIndexOf(".");
  return lastDot > 0 && lastDot < host.length - 1;
}
