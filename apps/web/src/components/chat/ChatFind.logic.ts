import { renderCodexDirectivesForCopy } from "@t3tools/client-runtime/codex-markdown-directives";
import type { TurnId } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import { resolveUserMessageContext } from "../../lib/composerContextRecords";
import {
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  type MarkdownFileLinkMeta,
} from "../../markdown-links";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "../../proposedPlan";
import type { TimelineEntry } from "../../session-logic";

export interface ChatFindMatch {
  /** Timeline entry id; message and plan rows reuse it as their row id. */
  readonly entryId: string;
  readonly turnId: TurnId | null;
  /** Zero-based occurrence within the entry's text, in document order. */
  readonly occurrence: number;
}

export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive literal search. Whitespace in the query matches any
 * whitespace run so a phrase still matches across soft wraps and block
 * boundaries in the rendered text.
 */
export function buildChatFindPattern(query: string): RegExp | null {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return new RegExp(words.map(escapeRegExp).join("\\s+"), "giu");
}

export function findPatternSpans(text: string, pattern: RegExp): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) break;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

export interface MarkdownSearchTextOptions {
  /** Workspace root; decides which code spans and links render as file chips. */
  readonly cwd?: string | undefined;
  /** Whether raw HTML tags render as markup (assistant) or as literal text (user). */
  readonly rawHtml?: boolean;
}

// A private-use character no message text contains, kept out of the source as an escape.
const PLACEHOLDER = String.fromCharCode(0xe000);
const PLACEHOLDER_PATTERN = new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g");
const ESCAPED_PUNCTUATION = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;
const CHARACTER_REFERENCE = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const NAMED_REFERENCES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: String.fromCharCode(0xa0),
};

function decodeCharacterReference(whole: string, reference: string): string {
  if (reference.startsWith("#")) {
    const hex = reference[1]?.toLowerCase() === "x";
    const code = Number.parseInt(reference.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }
  return NAMED_REFERENCES[reference.toLowerCase()] ?? whole;
}

/** The chip label ChatMarkdown shows in place of a file path. */
function fileChipLabel(meta: MarkdownFileLinkMeta): string {
  const position = meta.line ? ` · L${meta.line}${meta.column ? `:C${meta.column}` : ""}` : "";
  return `${meta.basename}${position}`;
}

/** Literals can hold placeholders captured by an earlier pass; unwrap until none remain. */
function restoreLiterals(text: string, literals: ReadonlyArray<string>): string {
  let result = text;
  for (let depth = 0; depth <= literals.length && result.includes(PLACEHOLDER); depth += 1) {
    result = result.replace(
      PLACEHOLDER_PATTERN,
      (_, index: string) => literals[Number(index)] ?? "",
    );
  }
  return result;
}

/**
 * Approximates the rendered text of a Markdown source so match counts line up
 * with what highlighting finds in the DOM: delimiters, link and image targets,
 * fences, headings and list markers are dropped while their text is kept, and
 * file paths become the chip labels the renderer shows. Every rule is bounded
 * to a line so an unclosed delimiter cannot make the pass quadratic.
 */
export function markdownSearchText(
  markdown: string,
  { cwd, rawHtml = true }: MarkdownSearchTextOptions = {},
): string {
  // Code renders literally, so its contents skip the HTML and emphasis rules.
  const literals: string[] = [];
  const keep = (text: string) => `${PLACEHOLDER}${literals.push(text) - 1}${PLACEHOLDER}`;
  const inlineCode = (body: string) => {
    const meta = resolveInlineCodeFileLinkMeta(body, cwd);
    return keep(meta ? fileChipLabel(meta) : body);
  };
  const link = (label: string, href: string) => {
    const meta = resolveMarkdownFileLinkMeta(href, cwd);
    return meta ? keep(fileChipLabel(meta)) : label;
  };
  let text = markdown
    // A fence closes on the same marker at least as long as the opening one.
    .replace(/^[ \t]*(`{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1`*[ \t]*$/gm, (_, _fence, body: string) =>
      keep(body),
    )
    .replace(/^[ \t]*(~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1~*[ \t]*$/gm, (_, _fence, body: string) =>
      keep(body),
    )
    .replace(/(`+)([^`]+?)\1/g, (_, _ticks, body: string) => inlineCode(body))
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*$/gm, "")
    // Escaped punctuation renders literally and must not open markup below.
    .replace(ESCAPED_PUNCTUATION, (_, char: string) => keep(char))
    // Images contribute no text; their alt is not rendered.
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "")
    .replace(/\[([^\]\n]+)\]\(([^)\n]*)\)/g, (_, label: string, href: string) => link(label, href))
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1");
  if (rawHtml) text = text.replace(/<\/?[a-zA-Z][^>\n]*>/g, "");
  text = text
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, "")
    // Table cells render as separate blocks; the pipes between them do not.
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, cells: string) => cells.replaceAll("|", " "))
    .replace(/`+/g, "")
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?![\w*])/g, "$1$2")
    .replace(CHARACTER_REFERENCE, decodeCharacterReference);
  return restoreLiterals(text, literals);
}

/** Context chips are buttons with no searchable text. */
function userMessageMarkdown(message: Parameters<typeof resolveUserMessageContext>[0]): string {
  return replaceComposerContextReferences(resolveUserMessageContext(message).text, () => "");
}

/** The card shows the plan title as its heading and the body without that heading. */
function proposedPlanSearchText(planMarkdown: string, cwd: string | undefined): string {
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  return `${title}\n${markdownSearchText(stripDisplayedPlanMarkdown(planMarkdown), { cwd })}`;
}

interface CachedSearchText {
  readonly input: string;
  readonly cwd: string | undefined;
  readonly text: string;
}

// Normalizing runs on every keystroke over every loaded entry, so a message
// is only normalized again when its text changes.
const searchTextCache = new WeakMap<object, CachedSearchText>();

function cachedSearchText(
  key: object,
  input: string,
  cwd: string | undefined,
  compute: () => string,
): string {
  const hit = searchTextCache.get(key);
  if (hit && hit.input === input && hit.cwd === cwd) return hit.text;
  const text = compute();
  searchTextCache.set(key, { input, cwd, text });
  return text;
}

/**
 * Text a find can land on: what the conversation shows once a turn settles.
 * Thinking is grouped with tool activity behind its own disclosure and system
 * messages never render, so counting them would point at nothing.
 */
export function chatFindEntrySource(
  entry: TimelineEntry,
  cwd?: string,
): { text: string; turnId: TurnId | null } | null {
  switch (entry.kind) {
    case "message": {
      const { message } = entry;
      if (message.role === "user") {
        return {
          text: cachedSearchText(message, message.text, cwd, () =>
            markdownSearchText(userMessageMarkdown(message), { cwd, rawHtml: false }),
          ),
          turnId: message.turnId,
        };
      }
      if (message.role === "assistant") {
        return {
          text: cachedSearchText(message, message.text, cwd, () =>
            markdownSearchText(renderCodexDirectivesForCopy(message.text), { cwd }),
          ),
          turnId: message.turnId,
        };
      }
      return null;
    }
    case "proposed-plan": {
      const plan = entry.proposedPlan;
      return {
        text: cachedSearchText(plan, plan.planMarkdown, cwd, () =>
          proposedPlanSearchText(plan.planMarkdown, cwd),
        ),
        turnId: plan.turnId,
      };
    }
    default:
      return null;
  }
}

export function collectChatFindMatches(
  entries: ReadonlyArray<TimelineEntry>,
  pattern: RegExp | null,
  cwd?: string,
): ChatFindMatch[] {
  if (pattern === null) return [];
  const matches: ChatFindMatch[] = [];
  for (const entry of entries) {
    const source = chatFindEntrySource(entry, cwd);
    if (source === null || source.text.length === 0) continue;
    const count = findPatternSpans(source.text, pattern).length;
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      matches.push({ entryId: entry.id, turnId: source.turnId, occurrence });
    }
  }
  return matches;
}

/**
 * Keeps the active match by identity while history loads or streams, so a
 * prepended page does not shift the selection to a different message.
 */
export function resolveActiveMatchIndex(
  matches: ReadonlyArray<ChatFindMatch>,
  active: ChatFindMatch | null,
): number {
  if (matches.length === 0) return -1;
  if (active !== null) {
    const index = matches.findIndex(
      (match) => match.entryId === active.entryId && match.occurrence === active.occurrence,
    );
    if (index >= 0) return index;
  }
  return 0;
}

export function stepChatFindIndex(index: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (index < 0) return direction === 1 ? 0 : count - 1;
  return (index + direction + count) % count;
}

export function formatChatFindCount(activeIndex: number, count: number): string {
  if (count === 0) return "No results";
  return `${activeIndex + 1}/${count}`;
}
