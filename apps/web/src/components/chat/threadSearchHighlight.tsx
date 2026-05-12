import type { ReactNode } from "react";

const MATCH_HIGHLIGHT_CLASS_NAME =
  "rounded-[0.35rem] bg-warning/38 px-[0.12rem] py-[0.04rem] text-inherit ring-1 ring-warning/18";
const ACTIVE_HIGHLIGHT_CLASS_NAME =
  "rounded-[0.35rem] bg-warning px-[0.12rem] py-[0.04rem] text-black ring-1 ring-warning/45";

interface TextMatchRange {
  start: number;
  end: number;
}

interface HNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: unknown;
}

function normalizeQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function textContainsThreadSearchMatch(text: string, query: string): boolean {
  return findMatchRanges(text, query).length > 0;
}

function findMatchRanges(text: string, query: string): TextMatchRange[] {
  const normalizedQuery = normalizeQuery(query);
  if (normalizedQuery.length === 0) {
    return [];
  }

  const normalizedText = text.toLocaleLowerCase();
  const ranges: TextMatchRange[] = [];
  let searchStart = 0;

  while (searchStart <= normalizedText.length - normalizedQuery.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, searchStart);
    if (matchIndex < 0) {
      break;
    }
    ranges.push({
      start: matchIndex,
      end: matchIndex + normalizedQuery.length,
    });
    searchStart = matchIndex + normalizedQuery.length;
  }

  return ranges;
}

export function renderHighlightedText(
  text: string,
  query: string,
  keyPrefix: string,
  options?: { active?: boolean },
): ReactNode {
  const ranges = findMatchRanges(text, query);
  if (ranges.length === 0) {
    return text;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const [index, range] of ranges.entries()) {
    if (range.start > cursor) {
      nodes.push(text.slice(cursor, range.start));
    }
    nodes.push(
      <mark
        key={`${keyPrefix}:${index}:${range.start}`}
        data-thread-search-highlight={options?.active ? "active" : "match"}
        className={options?.active ? ACTIVE_HIGHLIGHT_CLASS_NAME : MATCH_HIGHLIGHT_CLASS_NAME}
      >
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

function buildHastHighlightNode(value: string, active: boolean): HNode {
  return {
    type: "element",
    tagName: "mark",
    properties: {
      "data-thread-search-highlight": active ? "active" : "match",
      className: active ? ACTIVE_HIGHLIGHT_CLASS_NAME : MATCH_HIGHLIGHT_CLASS_NAME,
    },
    children: [
      {
        type: "text",
        value,
      },
    ],
  };
}

function splitTextNode(node: HNode, query: string, active: boolean): HNode[] {
  const value = typeof node.value === "string" ? node.value : "";
  const ranges = findMatchRanges(value, query);
  if (ranges.length === 0) {
    return [node];
  }

  const parts: HNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      parts.push({
        type: "text",
        value: value.slice(cursor, range.start),
      });
    }
    parts.push(buildHastHighlightNode(value.slice(range.start, range.end), active));
    cursor = range.end;
  }

  if (cursor < value.length) {
    parts.push({
      type: "text",
      value: value.slice(cursor),
    });
  }

  return parts;
}

function isHNode(value: unknown): value is HNode {
  return typeof value === "object" && value !== null && typeof (value as HNode).type === "string";
}

function visitTree(node: HNode, query: string, active: boolean): void {
  const rawChildren = Array.isArray(node.children) ? node.children.filter(isHNode) : null;
  if (!rawChildren || rawChildren.length === 0) {
    return;
  }

  const nextChildren: HNode[] = [];
  for (const child of rawChildren) {
    if (child.type === "text") {
      nextChildren.push(...splitTextNode(child, query, active));
      continue;
    }

    visitTree(child, query, active);
    nextChildren.push(child);
  }

  node.children = nextChildren;
}

export function createThreadSearchHighlightRehypePlugin(
  query: string,
  options?: { active?: boolean },
): (() => (tree: unknown) => void) | undefined {
  const normalizedQuery = normalizeQuery(query);
  if (normalizedQuery.length === 0) {
    return undefined;
  }

  return () => {
    return (tree: unknown) => {
      if (!isHNode(tree)) {
        return;
      }
      visitTree(tree, normalizedQuery, options?.active ?? false);
    };
  };
}
