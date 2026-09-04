import type { Extension, Tokenizer } from "micromark-util-types";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified, type Processor } from "unified";

import { remarkCodexDirectives } from "./codexMarkdownDirectives.ts";
import { remarkNormalizeListItemIndentation } from "./markdownListIndentation.ts";

const START = "\uE200";
const SEPARATOR = "\uE202";
const END = "\uE201";
const PREFIX = `${START}cite${SEPARATOR}`;
const TOKEN = "codexCitation";
const SOURCE_ID = /^[A-Za-z0-9_-]+$/;
const LOCATOR = /^L\d+(?:-L\d+)?$/;
const RAW_HTML_CONTAINERS = new Set(["a", "code", "pre", "script", "style", "textarea"]);

declare module "micromark-util-types" {
  interface TokenTypeMap {
    codexCitation: "codexCitation";
  }
}

export interface CodexCitation {
  readonly raw: string;
  readonly sources: ReadonlyArray<{ readonly id: string; readonly number: number }>;
  readonly locator?: string;
}

interface CitationOptions {
  readonly isStreaming?: boolean;
}

interface MarkdownPoint {
  readonly line: number;
  readonly column: number;
  readonly offset?: number;
}

interface MarkdownNode {
  type?: string;
  value?: string;
  position?: { readonly start: MarkdownPoint; readonly end: MarkdownPoint };
  data?: {
    codexCitationMarkdown?: string;
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownNode[];
}

const citationTokens = new WeakMap<MarkdownNode, string>();

export const CODEX_CITATION_HAST_PROPERTIES = ["dataCodexCitation"] as const;

function parseCitation(raw: string) {
  if (!raw.startsWith(PREFIX) || !raw.endsWith(END)) return null;
  const ids = raw.slice(PREFIX.length, -END.length).split(SEPARATOR);
  if (!ids.every((id) => SOURCE_ID.test(id))) return null;
  const last = ids.at(-1);
  const locator =
    ids.length > 1 && last !== undefined && LOCATOR.test(last) ? ids.pop() : undefined;
  return { ids: [...new Set(ids)], ...(locator === undefined ? {} : { locator }) };
}

function isSourceCharacter(code: number | null): code is number {
  return (
    code !== null &&
    ((code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 45 ||
      code === 95)
  );
}

const tokenizeCitation: Tokenizer = function (effects, ok, nok) {
  let prefixIndex = 0;
  let segmentHasCharacters = false;
  return prefix;

  function finish(code: number | null) {
    effects.exit(TOKEN);
    return ok(code);
  }

  function prefix(code: number | null) {
    if (code === null && prefixIndex > 0) return finish(code);
    if (code !== PREFIX.charCodeAt(prefixIndex)) return nok(code);
    if (prefixIndex === 0) effects.enter(TOKEN);
    effects.consume(code);
    prefixIndex += 1;
    return prefixIndex === PREFIX.length ? source : prefix;
  }

  function source(code: number | null) {
    if (code === null) return finish(code);
    if (isSourceCharacter(code)) {
      segmentHasCharacters = true;
      effects.consume(code);
      return source;
    }
    if (!segmentHasCharacters) return nok(code);
    if (code === SEPARATOR.charCodeAt(0)) {
      segmentHasCharacters = false;
      effects.consume(code);
      return source;
    }
    if (code === END.charCodeAt(0)) {
      effects.consume(code);
      return finish;
    }
    return nok(code);
  }
};

const CITATION_SYNTAX: Extension = {
  text: { [START.charCodeAt(0)]: { tokenize: tokenizeCitation } },
};

export function codexCitationText(citation: CodexCitation): string {
  const sources = citation.sources.map(({ id, number }) => `Source ${number}: ${id}`);
  if (citation.locator !== undefined) sources.push(citation.locator);
  return `[${sources.join("; ")}]`;
}

/** Keeps the opaque source IDs readable without inventing link destinations. */
export function codexCitationMarkdown(citation: CodexCitation): string {
  return codexCitationText(citation).replace(/[\\[\]*_`<&]/g, "\\$&");
}

function updateHtmlContext(value: string, tags: string[]): void {
  if (value.startsWith("<!") || value.startsWith("<?")) return;
  for (const match of value.matchAll(
    /<\s*(\/?)\s*([a-z][a-z0-9-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi,
  )) {
    const tag = match[2]?.toLowerCase();
    if (tag === undefined || !RAW_HTML_CONTAINERS.has(tag)) continue;
    if (match[1]) {
      const index = tags.lastIndexOf(tag);
      if (index !== -1) tags.splice(index);
    } else if (!match[0].endsWith("/>")) {
      tags.push(tag);
    }
  }
}

function transformCitations(tree: MarkdownNode, source: string, options: CitationOptions): void {
  const numbers = new Map<string, number>();
  const htmlTags: string[] = [];

  function visit(node: MarkdownNode, excluded = false): MarkdownNode[] {
    if (node.type === "html") {
      if (!excluded) updateHtmlContext(node.value ?? "", htmlTags);
      return [node];
    }

    const raw = citationTokens.get(node);
    if (raw !== undefined && node.position !== undefined) {
      citationTokens.delete(node);
      const end = {
        line: node.position.start.line,
        column: node.position.start.column + raw.length,
        ...(node.position.start.offset === undefined
          ? {}
          : { offset: node.position.start.offset + raw.length }),
      };
      const parsed = parseCitation(raw);
      const hidden =
        parsed === null &&
        !raw.endsWith(END) &&
        options.isStreaming === true &&
        end.offset === source.length;
      if (excluded || htmlTags.length > 0 || (parsed === null && !hidden)) return [node];

      const citation = parsed && {
        raw,
        sources: parsed.ids.map((id) => {
          let number = numbers.get(id);
          if (number === undefined) {
            number = numbers.size + 1;
            numbers.set(id, number);
          }
          return { id, number };
        }),
        ...(parsed.locator === undefined ? {} : { locator: parsed.locator }),
      };
      const replacement: MarkdownNode = {
        type: "text",
        value: citation ? codexCitationText(citation) : "",
        position: { start: node.position.start, end },
        data: {
          codexCitationMarkdown: citation ? codexCitationMarkdown(citation) : "",
          ...(citation
            ? {
                hName: "span",
                hProperties: { dataCodexCitation: JSON.stringify(citation) },
              }
            : {}),
        },
      };
      // mdast can append following text to this token's text node.
      const tail = node.value?.slice(raw.length);
      return tail
        ? [
            replacement,
            {
              type: "text",
              value: tail,
              position: { start: end, end: node.position.end },
            },
          ]
        : [replacement];
    }

    const excludeChildren =
      excluded ||
      node.type === "link" ||
      node.type === "linkReference" ||
      node.type === "image" ||
      node.type === "imageReference" ||
      node.type === "code" ||
      node.type === "inlineCode";
    if (node.children) {
      node.children = node.children.flatMap((child) => visit(child, excludeChildren));
    }
    return [node];
  }

  visit(tree);
}

/** Tokenizes citations before Markdown can interpret underscores inside source IDs. */
function attachCodexCitations(this: Processor, options: CitationOptions = {}) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(CITATION_SYNTAX);
  (data.fromMarkdownExtensions ??= []).push({
    enter: {
      codexCitation(token) {
        const raw = this.sliceSerialize(token);
        const node = { type: "text" as const, value: raw };
        citationTokens.set(node, raw);
        this.enter(node, token);
      },
    },
    exit: {
      codexCitation(token) {
        this.exit(token);
      },
    },
  });

  return (tree: unknown, file: { readonly value: unknown }) => {
    const source = String(file.value);
    if (source.includes(START)) transformCitations(tree as MarkdownNode, source, options);
  };
}

export const remarkCodexCitations = attachCodexCitations;

const citationParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkNormalizeListItemIndentation)
  .use(remarkCodexDirectives)
  .use(remarkCodexCitations)
  .freeze();
const streamingCitationParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkNormalizeListItemIndentation)
  .use(remarkCodexDirectives)
  .use(remarkCodexCitations, { isStreaming: true })
  .freeze();

/** Replaces only citation source ranges; all other Markdown remains byte-for-byte intact. */
export function renderCodexCitationsAsMarkdown(
  markdown: string,
  options: CitationOptions = {},
): string {
  if (!markdown.includes(START)) return markdown;
  const parser = options.isStreaming ? streamingCitationParser : citationParser;
  const tree = parser.runSync(parser.parse(markdown), { value: markdown }) as MarkdownNode;
  const replacements: { readonly start: number; readonly end: number; readonly text: string }[] =
    [];
  function collect(node: MarkdownNode): void {
    const text = node.data?.codexCitationMarkdown;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (text !== undefined && start !== undefined && end !== undefined) {
      replacements.push({ start, end, text });
    }
    for (const child of node.children ?? []) collect(child);
  }
  collect(tree);
  let rendered = "";
  let cursor = 0;
  for (const replacement of replacements) {
    rendered += markdown.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  return rendered + markdown.slice(cursor);
}

export function codexCitationFromHastProperties(
  properties: Readonly<Record<string, unknown>> | null | undefined,
): CodexCitation | null {
  const serialized = properties?.dataCodexCitation;
  if (typeof serialized !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("raw" in value)) return null;
  if (typeof value.raw !== "string" || !("sources" in value) || !Array.isArray(value.sources)) {
    return null;
  }
  const parsed = parseCitation(value.raw);
  if (!parsed || parsed.ids.length !== value.sources.length) return null;
  const locator = "locator" in value ? value.locator : undefined;
  if (locator !== parsed.locator) return null;
  const sources: { readonly id: string; readonly number: number }[] = [];
  const rawSources: readonly unknown[] = value.sources;
  for (const [index, source] of rawSources.entries()) {
    if (
      typeof source !== "object" ||
      source === null ||
      !("id" in source) ||
      typeof source.id !== "string" ||
      source.id !== parsed.ids[index] ||
      !("number" in source) ||
      typeof source.number !== "number" ||
      !Number.isSafeInteger(source.number) ||
      source.number <= 0
    ) {
      return null;
    }
    sources.push({ id: source.id, number: source.number });
  }
  return {
    raw: value.raw,
    sources,
    ...(parsed.locator === undefined ? {} : { locator: parsed.locator }),
  };
}
