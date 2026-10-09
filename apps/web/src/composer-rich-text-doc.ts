import { joinBackward, joinTextblockBackward, joinTextblockForward } from "@tiptap/pm/commands";
import { Fragment, Mark, type Node as ProseMirrorNode, type ResolvedPos } from "@tiptap/pm/model";
import { Code } from "@tiptap/extension-code";
import { Blockquote } from "@tiptap/extension-blockquote";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Heading } from "@tiptap/extension-heading";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { type Command, type Editor, mergeAttributes } from "@tiptap/core";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import {
  type EditorState,
  Plugin,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";

import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import { nextOrderedMarkerText } from "~/composer-list-continuation";
import { parseInlineMarkdown, RICH_TEXT_DELIMITERS, type RichTextMark } from "~/composer-rich-text";
import { collectInlineContextIds } from "~/lib/composerContextReferences";

/**
 * Pure document model for the rich text (Tiptap) composer.
 *
 * The stored prompt stays markdown (`**bold**`, `@file` chips as canonical
 * links). The Tiptap document holds styled text plus inline atom chips, so
 * this module translates both ways and maps cursor offsets between the three
 * coordinate spaces the composer speaks:
 *
 * - flat document offsets (styled markers excluded, chips count 1),
 * - collapsed cursor offsets (markers literal, chips count 1 — the coordinate
 *   the draft store and mention detection use),
 * - markdown offsets (markers literal, chips expand to their source).
 *
 * DOM-free on purpose: unit tests build a real ProseMirror document from the
 * JSON this produces and assert the round trip without a browser.
 */

export type SkillMeta = { label: string; description: string | null };

/** Outermost mark first, so closers mirror openers when nested. */
const MARK_NESTING_ORDER: RichTextMark[] = ["strike", "bold", "italic", "code"];

const MARK_TO_TIPTAP: Record<RichTextMark, string> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
};

const TIPTAP_TO_MARK: Record<string, RichTextMark> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
};

/**
 * Tiptap's code mark excludes every other mark, which rejects the `bold+code`
 * spans markdown like `**\`x\`**` parses into and drops the whole insert.
 * Code nests inside emphasis here, so it only excludes itself like the rest.
 */
export const ComposerCodeExtension = Code.extend({
  excludes: "code",
  // ArrowRight leaves code through the caret stops at styled edges, so the
  // stock exit (inserting a space at the end of a line) is not needed.
  exitable: false,
});

/**
 * Tiptap's block extensions each bind a chord that turns the current block
 * into their node (Mod-Shift-8 for a list, Mod-Alt-c for a fence, and so on).
 * The composer does not offer them, and they are not harmless: run inside a
 * quote they nest a block the quote serializer cannot write, and the text in
 * it drops out of the stored draft. `drop` names the chords to remove; the
 * keys the composer relies on, such as Backspace and the arrows at a block's
 * edge, stay.
 */
function withoutBlockChords<Shortcuts extends Record<string, unknown>>(
  shortcuts: Shortcuts | undefined,
  drop: readonly string[],
): Shortcuts {
  return Object.fromEntries(
    Object.entries(shortcuts ?? {}).filter(([key]) => !drop.includes(key)),
  ) as Shortcuts;
}

/**
 * What a list item may hold: its own line, then nested lists. That is all the
 * Markdown can write, so ProseMirror refuses any join, wrap or paste that
 * would put a second line or another block into an item.
 */
const LIST_ITEM_CONTENT = "paragraph list*";

/** Task lists come from `- [ ]` alone; Mod-Shift-9 would nest one in a quote. */
export const ComposerTaskListExtension = TaskList.extend({
  addKeyboardShortcuts() {
    return withoutBlockChords(this.parent?.(), ["Mod-Shift-9"]);
  },
});

/**
 * Tiptap's Tab and Shift-Tab sink and lift an item without touching its
 * `indent`, so the stored draft keeps the old nesting and the next rebuild
 * undoes the move. The composer nests through its own Tab, which edits the
 * source the way plain mode does.
 */
const LIST_NESTING_KEYS = ["Tab", "Shift-Tab"];

/**
 * Task list items keep their exact source indent in an attribute so nesting
 * round-trips byte-identically. Checkbox case (`[X]`) normalizes to `[x]` —
 * the same fixed-point deal as `__bold__` becoming `**bold**`.
 */
export const ComposerTaskItemExtension = TaskItem.extend({
  content: LIST_ITEM_CONTENT,
  addAttributes() {
    return {
      ...this.parent?.(),
      indent: { default: "" },
      markerSpace: { default: " " },
      contentSpace: { default: null },
    };
  },
  addKeyboardShortcuts() {
    return withoutBlockChords(this.parent?.(), LIST_NESTING_KEYS);
  },
}).configure({ nested: true });

/**
 * Fenced code blocks keep their exact source delimiters so a fence round-trips
 * byte-identically: `fence` is the opening run of backticks or tildes,
 * `language` its info string, and `close` the closing newline and fence, or
 * the empty string when the fence was never closed.
 *
 * Neither delimiter owns a document character, so the caret can never land
 * inside a fence — the same deal as a checkbox marker.
 *
 * An empty block written with a blank line (```` ```\n\n``` ````) canonicalizes
 * to the blank-free form, the same fixed-point deal as `__bold__` becoming
 * `**bold**`.
 */
export const ComposerCodeBlockExtension = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      language: { default: "" },
      fence: { default: "```" },
      close: { default: "\n```" },
    };
  },
  addKeyboardShortcuts() {
    return {
      ...withoutBlockChords(this.parent?.(), ["Mod-Alt-c"]),
      Backspace: () => unwrapCodeBlockAtStart(this.editor),
    };
  },
});

/**
 * Backspace at the start of a fence removes the fence and keeps its lines as
 * paragraphs, the way it removes a list marker. Joining the code onto the line
 * above instead would drop the fence from the draft and leave the rest of the
 * code as stray lines.
 */
function unwrapCodeBlockAtStart(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== "codeBlock" || $from.parentOffset !== 0) return false;
  const { schema } = editor.state;
  const paragraphs = $from.parent.textContent
    .split("\n")
    .map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null));
  const start = $from.before();
  const tr = editor.state.tr.replaceWith(start, $from.after(), paragraphs);
  editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)));
  return true;
}

/**
 * The markdown a code block node serializes to, delimiters included. `followed`
 * says another block comes after it in the draft.
 */
function codeBlockSource(
  node: ProseMirrorNode,
  followed: boolean,
): {
  open: string;
  content: string;
  close: string;
} {
  const attrs = node.attrs as Record<string, unknown>;
  let fence = typeof attrs.fence === "string" && attrs.fence ? attrs.fence : "```";
  const language = typeof attrs.language === "string" ? attrs.language : "";
  let close = typeof attrs.close === "string" ? attrs.close : "";
  const content = node.textContent;
  // Code holding a line that would close the fence, such as a pasted fence,
  // is written inside a longer one, so the agent reads all of it as code. A
  // parsed block never holds such a line, so its source stays byte-identical.
  const longest = Math.max(
    0,
    ...content
      .split("\n")
      .filter((line) => isClosingFence(line, fence))
      .map((line) => /^[`~]+/.exec(line)![0].length),
  );
  if (longest > 0) {
    fence = fence[0]!.repeat(longest + 1);
    if (close) close = `\n${fence}`;
  }
  // An unclosed fence runs to the end of the draft, so with a block after it
  // the fence is written closed, or the next rebuild would read that block as code.
  if (!close && followed) close = `\n${fence}`;
  return { open: `${fence}${language}${content ? "\n" : ""}`, content, close };
}

/**
 * Bullet and ordered items keep their exact source marker so a list
 * round-trips byte-identically: `marker` is the literal `-`, `*`, `+`, `3.`
 * or `3)`, `space` what followed it, and `indent` the leading whitespace.
 * Numbering is not renumbered: what the user typed is what the agent gets.
 */
const ComposerListItemExtension = ListItem.extend({
  content: LIST_ITEM_CONTENT,
  addAttributes() {
    return {
      ...this.parent?.(),
      indent: { default: "" },
      marker: { default: "-" },
      space: { default: " " },
    };
  },
  addKeyboardShortcuts() {
    return {
      ...withoutBlockChords(this.parent?.(), LIST_NESTING_KEYS),
      // Task items share these: the list extensions are always loaded together.
      Backspace: () => backspaceAcrossList(this.editor),
      Delete: () => deleteAcrossList(this.editor),
    };
  },
  // The source marker rides on the item so the composer draws `3)` and a
  // nested `7.` as written, rather than the browser own numbering.
  renderHTML({ node, HTMLAttributes }) {
    return ["li", mergeAttributes(HTMLAttributes, { "data-marker": node.attrs.marker }), 0];
  },
});

export const ComposerListExtensions = [
  BulletList.extend({
    addKeyboardShortcuts() {
      return withoutBlockChords(this.parent?.(), ["Mod-Shift-8"]);
    },
  }),
  OrderedList.extend({
    addKeyboardShortcuts() {
      return withoutBlockChords(this.parent?.(), ["Mod-Shift-7"]);
    },
  }),
  ComposerListItemExtension,
];

/**
 * A quote keeps the exact `>` prefix its lines were written with, applied to
 * every line, so it round-trips byte-identically and a new line typed inside
 * it gets the same prefix. One source line is one paragraph; a line whose
 * prefix differs starts a sibling quote. Nested markers and list markers
 * inside a quote stay literal text: the composer quotes prose, not documents.
 */
const ComposerBlockquoteExtension = Blockquote.extend({
  content: "paragraph+",
  addAttributes() {
    return { ...this.parent?.(), prefix: { default: "> " } };
  },
  addKeyboardShortcuts() {
    return withoutBlockChords(this.parent?.(), ["Mod-Shift-b"]);
  },
});

/**
 * A rule keeps the exact line it was written as (`---`, `* * *`, `_____`), so
 * it round-trips byte-identically. It owns no document characters: offsets
 * inside its source clamp to the block after it.
 *
 * A rule cannot hold the caret, so a document never ends in one: an empty
 * line follows it, which the draft does not write (see `isTrailingLineAfterRule`).
 * A draft ending in `---\n` reads back the same way and so loses that newline,
 * the same fixed-point deal as `__bold__` becoming `**bold**`.
 */
const ComposerHorizontalRuleExtension = HorizontalRule.extend({
  addAttributes() {
    return { ...this.parent?.(), source: { default: "---" } };
  },
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        appendTransaction: (transactions, _, state) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          if (state.doc.lastChild?.type.name !== "horizontalRule") return null;
          return state.tr.insert(state.doc.content.size, state.schema.nodes.paragraph!.create());
        },
      }),
    ];
  },
});

/** The empty line after a rule that ends the document, which writes nothing. */
function isTrailingLineAfterRule(doc: ProseMirrorNode, index: number): boolean {
  const block = doc.child(index);
  return (
    index === doc.childCount - 1 &&
    index > 0 &&
    block.type.name === "paragraph" &&
    block.content.size === 0 &&
    doc.child(index - 1).type.name === "horizontalRule"
  );
}

/**
 * A heading keeps the exact whitespace between its `#`s and its text. The
 * `#`s must be followed by whitespace to count, which is also what keeps a
 * `#1234` pull request reference a reference: the marker owns no document
 * characters, closing `#`s stay literal text, and nothing is ever stripped.
 */
const ComposerHeadingExtension = Heading.extend({
  addAttributes() {
    return { ...this.parent?.(), space: { default: " " } };
  },
  // Its only shortcuts are the Mod-Alt-1…6 block chords.
  addKeyboardShortcuts() {
    return {};
  },
});

/** Block-level nodes beyond lists and fences, in the order the parser tries them. */
export const ComposerBlockExtensions = [
  ComposerBlockquoteExtension,
  ComposerHorizontalRuleExtension,
  ComposerHeadingExtension,
];

function randomNodeKey(): string {
  return `tiptap-${Math.random().toString(36).slice(2)}`;
}

interface TaskLinePrefix {
  indent: string;
  checked: boolean;
  markerSpace: string;
  contentSpace: string;
}

function parseTaskPrefix(head: string): { prefix: TaskLinePrefix; markerLength: number } | null {
  const match = head.match(/^([ \t]*)-([ \t]+)\[([ xX])\]([ \t]*)/);
  if (!match) return null;
  const after = head.slice(match[0].length);
  if (after.length > 0 && !match[4]) return null;
  return {
    prefix: {
      indent: match[1] ?? "",
      checked: (match[3] ?? " ").toLowerCase() === "x",
      markerSpace: match[2]!,
      contentSpace: match[4]!,
    },
    markerLength: match[0].length,
  };
}

/**
 * An opening fence: three or more backticks or tildes at the start of a line,
 * followed by an info string. A backtick fence cannot carry a backtick in its
 * info string, which is what keeps `` `code` `` on its own line literal.
 * Indented fences stay paragraphs — the composer is a prompt box, not a
 * CommonMark renderer, and honoring indentation would cost another attribute
 * for no case anyone writes.
 */
export function parseOpeningFence(line: string): { fence: string; language: string } | null {
  // `[^\n]` rather than `.`, here and in the block rules: a CRLF draft's lines
  // end in `\r`, which `.` refuses, and the `\r` stays in the stored text.
  const match = /^(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!match) return null;
  const fence = match[1]!;
  const language = match[2]!;
  if (fence.startsWith("`") && language.includes("`")) return null;
  return { fence, language };
}

/** A closing fence matches the opening run's character and is at least as long. */
export function isClosingFence(line: string, fence: string): boolean {
  const match = /^(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  if (!match) return false;
  const run = match[1]!;
  return run[0] === fence[0] && run.length >= fence.length;
}

type ListLinePrefix =
  | ({ kind: "task" } & TaskLinePrefix)
  | { kind: "bullet" | "ordered"; indent: string; marker: string; space: string };

/**
 * The same grammar the literal continuation uses, so plain and rich mode agree
 * on what a list line is: a task first (it also looks like a bullet), then an
 * ordered marker, then a bullet. A marker followed by nothing is an empty item.
 */
function parseListPrefix(line: string): { prefix: ListLinePrefix; markerLength: number } | null {
  const task = parseTaskPrefix(line);
  if (task) return { prefix: { kind: "task", ...task.prefix }, markerLength: task.markerLength };
  const ordered = /^([ \t]*)(\d+[.)])((?:[ \t]+)|$)/.exec(line);
  if (ordered) {
    return {
      prefix: { kind: "ordered", indent: ordered[1]!, marker: ordered[2]!, space: ordered[3]! },
      markerLength: ordered[0].length,
    };
  }
  const bullet = /^([ \t]*)([-*+])((?:[ \t]+)|$)/.exec(line);
  if (bullet) {
    return {
      prefix: { kind: "bullet", indent: bullet[1]!, marker: bullet[2]!, space: bullet[3]! },
      markerLength: bullet[0].length,
    };
  }
  return null;
}

/** Items of one kind and marker family belong to one list; a change starts a sibling list. */
function listKey(prefix: ListLinePrefix): string {
  if (prefix.kind === "task") return "task";
  if (prefix.kind === "ordered") return `ordered:${prefix.marker.slice(-1)}`;
  return `bullet:${prefix.marker}`;
}

type InlineJson = Record<string, unknown>;

interface DocLine {
  list: ListLinePrefix | null;
  inline: InlineJson[];
}

function atomJsonForSegment(
  segment: Exclude<ReturnType<typeof splitPromptIntoComposerSegments>[number], { type: "text" }>,
  skillLabelFor: (name: string) => SkillMeta,
): InlineJson {
  if (segment.type === "mention") {
    return {
      type: "composer-mention",
      attrs: { path: segment.path, source: segment.source },
    };
  }
  if (segment.type === "skill") {
    const meta = skillLabelFor(segment.name);
    return {
      type: "composer-skill",
      attrs: {
        skillName: segment.name,
        skillLabel: meta.label,
        skillDescription: meta.description,
      },
    };
  }
  if (segment.type === "citation") {
    return {
      type: "composer-citation",
      attrs: { citation: segment.citation, source: segment.source, citeKey: randomNodeKey() },
    };
  }
  return {
    type: "composer-context-reference",
    attrs: {
      kind: segment.kind,
      contextId: segment.contextId,
      label: segment.label,
      source: segment.source,
    },
  };
}

interface PendingItem {
  prefix: ListLinePrefix;
  content: InlineJson[];
  /** Nested lists, in order; a parent can hold lists of different kinds. */
  children: PendingList[];
}

interface PendingList {
  key: string;
  items: PendingItem[];
}

function listJson(list: PendingList): InlineJson {
  const first = list.items[0]!.prefix;
  const items = list.items.map((item) => {
    const content = [
      { type: "paragraph", content: item.content },
      ...item.children.map((child) => listJson(child)),
    ];
    if (item.prefix.kind === "task") {
      return {
        type: "taskItem",
        attrs: {
          checked: item.prefix.checked,
          indent: item.prefix.indent,
          markerSpace: item.prefix.markerSpace,
          contentSpace: item.prefix.contentSpace,
        },
        content,
      };
    }
    return {
      type: "listItem",
      attrs: { indent: item.prefix.indent, marker: item.prefix.marker, space: item.prefix.space },
      content,
    };
  });
  if (first.kind === "task") return { type: "taskList", content: items };
  if (first.kind === "ordered") {
    return {
      type: "orderedList",
      attrs: { start: Number.parseInt(first.marker, 10) || 1 },
      content: items,
    };
  }
  return { type: "bulletList", content: items };
}

function textJsonForSpan(text: string, marks: RichTextMark[]): Record<string, unknown> {
  const json: Record<string, unknown> = { type: "text", text };
  if (marks.length > 0) {
    json.marks = [...marks]
      .sort((a, b) => MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b))
      .map((mark) => ({ type: MARK_TO_TIPTAP[mark] }));
  }
  return json;
}

export function buildTiptapContent(
  value: string,
  skillLabelFor: (name: string) => SkillMeta,
  options?: { styling?: boolean; blocks?: boolean; literalText?: boolean },
): Record<string, unknown>[] {
  // Editor answers are verbatim text, including Markdown and context-token sources.
  if (options?.literalText) {
    return value.split("\n").map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    }));
  }
  const styling = options?.styling ?? true;
  // Inline marks without block structure: text pasted into a list item or
  // quote, which has no line to write a nested block into.
  const blockSyntax = styling && (options?.blocks ?? true);
  // Hide token source from the markdown parser, then restore the atoms with
  // the marks of their surrounding text. Choose a sentinel absent from input.
  let sentinel = "\uFFFC";
  for (let codePoint = 0xe000; value.includes(sentinel); codePoint += 1) {
    sentinel = String.fromCodePoint(codePoint);
  }
  const atoms: InlineJson[] = [];
  // Code fences hold no chips, so their lines put the original source back in
  // place of the sentinel rather than building an atom for it.
  const atomSources: string[] = [];
  const text = splitPromptIntoComposerSegments(value)
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      atoms.push(atomJsonForSegment(segment, skillLabelFor));
      atomSources.push(segment.source);
      return sentinel;
    })
    .join("");
  let atomIndex = 0;
  const buildInline = (content: string): InlineJson[] => {
    const spans = styling ? parseInlineMarkdown(content) : [{ text: content, marks: [] }];
    const inline: InlineJson[] = [];
    for (const span of spans) {
      span.text.split(sentinel).forEach((piece, index) => {
        if (index > 0) {
          const atom = atoms[atomIndex++]!;
          inline.push({ ...atom, marks: textJsonForSpan("", span.marks).marks });
        }
        if (piece) inline.push(textJsonForSpan(piece, span.marks));
      });
    }
    return inline;
  };
  const buildDocLine = (line: string): DocLine => {
    const parsed = blockSyntax ? parseListPrefix(line) : null;
    const content = parsed ? line.slice(parsed.markerLength) : line;
    return { list: parsed?.prefix ?? null, inline: buildInline(content) };
  };

  // Pass 1: fenced blocks claim their lines whole; everything else becomes an
  // inline-parsed line. Fence bodies restore chip sources as literal text.
  const sourceLines = text.split("\n");
  const entries: (
    | { code: Record<string, unknown> }
    | { rule: string }
    | { heading: { level: number; space: string; inline: InlineJson[] } }
    | { quote: { prefix: string; inline: InlineJson[] } }
    | { line: DocLine }
  )[] = [];
  const restoreSources = (line: string) =>
    line.split(sentinel).reduce((joined, piece, index) => {
      if (index === 0) return piece;
      atomIndex += 1;
      return joined + atomSources[atomIndex - 1]! + piece;
    }, "");

  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index]!;
    const opening = blockSyntax ? parseOpeningFence(line) : null;
    if (!opening) {
      // A thematic break outranks a list: `- - -` and `* * *` are rules, and
      // `***` on its own line is a rule rather than an empty bold span.
      if (blockSyntax && /^([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$/.test(line)) {
        entries.push({ rule: line });
        continue;
      }
      const heading = blockSyntax ? /^(#{1,6})([ \t]+)([^\n]*)$/.exec(line) : null;
      if (heading) {
        entries.push({
          heading: {
            level: heading[1]!.length,
            space: heading[2]!,
            inline: buildInline(heading[3]!),
          },
        });
        continue;
      }
      const quote = blockSyntax ? /^(>[ \t]*)([^\n]*)$/.exec(line) : null;
      if (quote) entries.push({ quote: { prefix: quote[1]!, inline: buildInline(quote[2]!) } });
      else entries.push({ line: buildDocLine(line) });
      continue;
    }
    // The info string went through the sentinel pass like every line, so a
    // token in it is put back as source here, in order, before the body.
    const language = restoreSources(opening.language);
    const body: string[] = [];
    let cursor = index + 1;
    let close = "";
    while (cursor < sourceLines.length) {
      const candidate = sourceLines[cursor]!;
      if (isClosingFence(candidate, opening.fence)) {
        close = `\n${candidate}`;
        break;
      }
      body.push(restoreSources(candidate));
      cursor += 1;
    }
    // An unclosed fence runs to the end of the prompt, which is what the user
    // is looking at while they are still typing the block.
    const closed = cursor < sourceLines.length;
    const content = body.join("\n");
    entries.push({
      code: {
        type: "codeBlock",
        attrs: { language, fence: opening.fence, close },
        ...(content ? { content: [{ type: "text", text: content }] } : {}),
      },
    });
    index = closed ? cursor : sourceLines.length;
  }

  // Pass 2: consecutive list lines group into (possibly nested) lists by
  // indent prefix; everything else stays a paragraph. Items of a different
  // kind or marker at the same indent start a sibling list, so `* a` under
  // `- b` keeps its star and a task list can follow a bullet list.
  const blocks: Record<string, unknown>[] = [];
  let rootLists: PendingList[] = [];
  let stack: { indent: string; list: PendingList; container: PendingList[] }[] = [];
  const flushLists = () => {
    for (const list of rootLists) blocks.push(listJson(list));
    rootLists = [];
    stack = [];
  };
  const openList = (container: PendingList[], key: string): PendingList => {
    const list = { key, items: [] };
    container.push(list);
    return list;
  };
  let openQuote: { prefix: string; content: InlineJson[][] } | null = null;
  const flushQuote = () => {
    if (!openQuote) return;
    blocks.push({
      type: "blockquote",
      attrs: { prefix: openQuote.prefix },
      content: openQuote.content.map((inline) => ({ type: "paragraph", content: inline })),
    });
    openQuote = null;
  };
  for (const entry of entries) {
    if ("quote" in entry) {
      flushLists();
      if (openQuote && openQuote.prefix !== entry.quote.prefix) flushQuote();
      openQuote ??= { prefix: entry.quote.prefix, content: [] };
      openQuote.content.push(entry.quote.inline);
      continue;
    }
    flushQuote();
    if ("code" in entry) {
      flushLists();
      blocks.push(entry.code);
      continue;
    }
    if ("rule" in entry) {
      flushLists();
      blocks.push({ type: "horizontalRule", attrs: { source: entry.rule } });
      continue;
    }
    if ("heading" in entry) {
      flushLists();
      blocks.push({
        type: "heading",
        attrs: { level: entry.heading.level, space: entry.heading.space },
        content: entry.heading.inline,
      });
      continue;
    }
    const line = entry.line;
    if (!line.list) {
      flushLists();
      blocks.push({ type: "paragraph", content: line.inline });
      continue;
    }
    const item: PendingItem = { prefix: line.list, content: line.inline, children: [] };
    const key = listKey(line.list);
    const indent = line.list.indent;
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top) {
        // A leading indented item with no parent flattens but keeps indent.
        stack.push({ indent, list: openList(rootLists, key), container: rootLists });
        continue;
      }
      if (top.indent === indent) {
        if (top.list.key !== key) top.list = openList(top.container, key);
        top.list.items.push(item);
        break;
      }
      if (top.indent !== "" && !indent.startsWith(top.indent)) {
        if (stack.length > 1) {
          stack.pop();
          continue;
        }
        top.indent = indent;
        if (top.list.key !== key) top.list = openList(top.container, key);
        top.list.items.push(item);
        break;
      }
      const parent = top.list.items[top.list.items.length - 1];
      if (!parent) {
        top.list.items.push(item);
        break;
      }
      const list = openList(parent.children, key);
      stack.push({ indent, list, container: parent.children });
      list.items.push(item);
      break;
    }
  }
  flushQuote();
  flushLists();
  return blocks;
}

export function buildDocJson(
  value: string,
  skillLabelFor: (name: string) => SkillMeta,
  options?: { styling?: boolean; literalText?: boolean },
) {
  const content = buildTiptapContent(value, skillLabelFor, options);
  // The empty line the rule extension keeps after a final rule.
  if (content.at(-1)?.type === "horizontalRule") content.push({ type: "paragraph" });
  return { type: "doc", content };
}

export interface RichRun {
  kind: "text" | "token" | "break" | "prefix";
  /** Flat document offset (atoms count 1, markers excluded). */
  flatStart: number;
  docLen: number;
  /** Collapsed cursor length (markers literal, tokens count 1). */
  collapsedLen: number;
  /** Markdown length (tokens expand to their source). */
  mdLen: number;
  /** Marker layout inside text runs. */
  openLen: number;
  closeLen: number;
  /** ProseMirror position of the run start. */
  pmPos: number;
  mdStart: number;
  collapsedStart: number;
  nodeName?: string;
}

export interface RichDocMap {
  value: string;
  runs: RichRun[];
  docLength: number;
  contextIds: string[];
}

function readAtomSource(node: ProseMirrorNode): string {
  const attrs = node.attrs as Record<string, unknown>;
  switch (node.type.name) {
    case "composer-mention":
    case "composer-citation":
    case "composer-context-reference":
      return typeof attrs.source === "string" ? attrs.source : "";
    case "composer-skill": {
      const name = typeof attrs.skillName === "string" ? attrs.skillName : "";
      return name ? `$${name}` : "";
    }
    default:
      return "";
  }
}

interface RichAccumulator {
  runs: RichRun[];
  value: string;
  flat: number;
  collapsed: number;
  md: number;
}

function pushBreakRun(acc: RichAccumulator, position?: number): void {
  const previous = acc.runs[acc.runs.length - 1];
  const pmPos = position ?? (previous ? previous.pmPos + previous.docLen : 1);
  // Block boundary: one newline in every coordinate space.
  acc.runs.push({
    kind: "break",
    flatStart: acc.flat,
    docLen: 1,
    collapsedLen: 1,
    mdLen: 1,
    openLen: 0,
    closeLen: 0,
    pmPos,
    mdStart: acc.md,
    collapsedStart: acc.collapsed,
  });
  acc.value += "\n";
  acc.flat += 1;
  acc.collapsed += 1;
  acc.md += 1;
}

function appendInlineRuns(
  container: ProseMirrorNode,
  contentStart: number,
  acc: RichAccumulator,
): void {
  const children: ProseMirrorNode[] = [];
  container.forEach((child) => {
    if (!child.isText || child.marks.some((mark) => mark.type.name === "code")) {
      children.push(child);
      return;
    }
    // Separate boundary whitespace so delimiters can move past it without
    // changing the document offsets or marks on the visible text.
    const text = child.text!;
    const start = text.length - text.trimStart().length;
    const end = Math.max(start, text.trimEnd().length);
    let offset = 0;
    for (const boundary of [start, end, text.length]) {
      if (boundary > offset) children.push(child.cut(offset, boundary));
      offset = boundary;
    }
  });
  // Emphasis cannot open or close next to whitespace. Retain a whitespace
  // mark only when its range has visible content on both sides.
  for (const mark of MARK_NESTING_ORDER) {
    if (mark === "code") continue;
    for (const direction of [1, -1]) {
      let hasContent = false;
      for (
        let index = direction === 1 ? 0 : children.length - 1;
        index >= 0 && index < children.length;
        index += direction
      ) {
        const child = children[index]!;
        if (
          child.type.name === "hardBreak" ||
          !child.marks.some((item) => item.type.name === mark)
        ) {
          hasContent = false;
        } else if (
          child.isText &&
          !child.marks.some((item) => item.type.name === "code") &&
          /^\s+$/.test(child.text!)
        ) {
          if (!hasContent)
            children[index] = child.mark(child.marks.filter((item) => item.type.name !== mark));
        } else {
          hasContent = true;
        }
      }
    }
  }
  // Longer shared marks surround shorter ones. This keeps both nested
  // formatting and formatting across chips inside a single delimiter pair.
  const markEnds = new Map<RichTextMark, number>();
  const orderedMarks: RichTextMark[][] = [];
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    const marks =
      child.type.name === "hardBreak"
        ? []
        : child.marks
            .map((mark) => TIPTAP_TO_MARK[mark.type.name])
            .filter((mark): mark is RichTextMark => Boolean(mark));
    for (const mark of MARK_NESTING_ORDER) {
      if (!marks.includes(mark)) markEnds.delete(mark);
      else if (!markEnds.has(mark)) markEnds.set(mark, index);
    }
    orderedMarks[index] = marks.sort(
      (a, b) =>
        markEnds.get(b)! - markEnds.get(a)! ||
        MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b),
    );
  }
  for (let index = 1; index < orderedMarks.length; index += 1) {
    const marks = orderedMarks[index]!;
    const retained: RichTextMark[] = [];
    for (const mark of orderedMarks[index - 1]!) {
      if (!marks.includes(mark)) break;
      retained.push(mark);
    }
    orderedMarks[index] = [...retained, ...marks.filter((mark) => !retained.includes(mark))];
  }
  const commonLength = (left: RichTextMark[], right: RichTextMark[]) => {
    let index = 0;
    while (index < left.length && left[index] === right[index]) index += 1;
    return index;
  };
  let inlineOffset = 0;
  children.forEach((child, index) => {
    const pmPos = contentStart + inlineOffset;
    inlineOffset += child.nodeSize;
    if (child.type.name === "hardBreak") {
      pushBreakRun(acc, pmPos);
      return;
    }
    const marks = orderedMarks[index]!;
    const open = marks
      .slice(commonLength(marks, orderedMarks[index - 1] ?? []))
      .map((mark) => RICH_TEXT_DELIMITERS[mark])
      .join("");
    const close = marks
      .slice(commonLength(marks, orderedMarks[index + 1] ?? []))
      .toReversed()
      .map((mark) => RICH_TEXT_DELIMITERS[mark])
      .join("");
    const source = child.isText ? child.text! : readAtomSource(child);
    const docLen = child.isText ? source.length : 1;
    const mdText = open + source + close;
    const collapsedLen = open.length + docLen + close.length;
    acc.runs.push({
      kind: child.isText ? "text" : "token",
      flatStart: acc.flat,
      docLen,
      collapsedLen,
      mdLen: mdText.length,
      openLen: open.length,
      closeLen: close.length,
      pmPos,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
      ...(child.isText ? {} : { nodeName: child.type.name }),
    });
    acc.value += mdText;
    acc.flat += docLen;
    acc.collapsed += collapsedLen;
    acc.md += mdText.length;
  });
  // Empty paragraphs have an editable position even though they emit no text.
  if (children.length === 0) {
    acc.runs.push({
      kind: "text",
      flatStart: acc.flat,
      docLen: 0,
      collapsedLen: 0,
      mdLen: 0,
      openLen: 0,
      closeLen: 0,
      pmPos: contentStart,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
    });
  }
}

const LIST_NODE_NAMES = new Set(["taskList", "bulletList", "orderedList"]);
const LIST_ITEM_NODE_NAMES = new Set(["taskItem", "listItem"]);

/**
 * Gives the list item at the caret the indent and marker of the sibling it
 * follows, or of the one after it when it is first. Tiptap moves items between
 * lists without touching these attributes, so without this the stored draft
 * keeps an outdented item at its old depth, and the next rebuild nests it again.
 */
function alignListItemWithSiblings(tr: Transaction, itemType: string): void {
  const $pos = tr.selection.$from;
  // A lift out of the list leaves the caret in a paragraph, possibly inside
  // an item of another kind, which did not move.
  if ($pos.depth < 3 || $pos.node(-1).type.name !== itemType) return;
  const item = $pos.node(-1);
  const list = $pos.node(-2);
  const index = $pos.index(-2);
  const sibling =
    index > 0 ? list.child(index - 1) : index + 1 < list.childCount ? list.child(index + 1) : null;
  if (!sibling) return;
  const attrs: Record<string, unknown> = { ...item.attrs, indent: sibling.attrs.indent };
  if (item.type.name === "taskItem") {
    attrs.markerSpace = sibling.attrs.markerSpace;
  } else {
    const marker = typeof sibling.attrs.marker === "string" ? sibling.attrs.marker : "-";
    attrs.marker = index > 0 && /^\d+[.)]$/.test(marker) ? nextOrderedMarkerText(marker) : marker;
  }
  tr.setNodeMarkup($pos.before(-1), undefined, attrs);
  if (typeof attrs.marker === "string" && /^\d+[.)]$/.test(attrs.marker)) {
    renumberFollowingItems(tr, $pos.before(-2), index, attrs.marker);
  }
}

/**
 * Counts the items after `index` on from `marker`, so an item inserted in the
 * middle of an ordered list pushes the rest down instead of repeating a number.
 * Only marker attributes change, so positions stay valid while walking.
 */
function renumberFollowingItems(
  tr: Transaction,
  listPos: number,
  index: number,
  marker: string,
): void {
  const list = tr.doc.nodeAt(listPos);
  if (!list) return;
  let pos = listPos + 1;
  let previous = marker;
  list.forEach((child, _, childIndex) => {
    if (childIndex > index) {
      previous = nextOrderedMarkerText(previous);
      if (child.attrs.marker !== previous) {
        tr.setNodeMarkup(pos, undefined, { ...child.attrs, marker: previous });
      }
    }
    pos += child.nodeSize;
  });
}

/**
 * Shift+Enter in a list or task item: split it, or on an empty item leave one
 * level of nesting. Either way the item at the caret ends up written with the
 * indent and marker of its new siblings.
 */
export function splitOrLiftListItem(editor: Editor): boolean {
  const $from = editor.state.selection.$from;
  const itemType = listItemTypeAt($from);
  if (!itemType) return false;
  const empty = $from.parent.content.size === 0;
  // One transaction, so the split or lift and the realignment undo together.
  const move: Command = ({ commands, tr }) => {
    const moved =
      commands.splitListItem(
        itemType,
        itemType === "taskItem" ? { checked: false } : { space: " " },
      ) ||
      (empty && commands.liftListItem(itemType));
    if (moved) alignListItemWithSiblings(tr, itemType);
    return moved;
  };
  return editor.can().command(move) && editor.chain().command(move).run();
}

/**
 * Deletes `from`–`to`, the typed `[ ]` at the start of a bullet item's text,
 * and makes that item a task where it stands. A task list holds only tasks, so
 * the bullet list splits around it into sibling lists, which is also how the
 * parser reads a change of list kind. Nested items and the item's own nested
 * lists stay where they are.
 */
export function convertBulletItemToTask(
  tr: Transaction,
  from: number,
  to: number,
  checked: boolean,
): void {
  tr.delete(from, to);
  const $pos = tr.doc.resolve(from);
  const item = $pos.node(-1);
  const list = $pos.node(-2);
  const index = $pos.index(-2);
  const { schema } = tr.doc.type;
  const before: ProseMirrorNode[] = [];
  const after: ProseMirrorNode[] = [];
  list.forEach((child, _, childIndex) => {
    if (childIndex < index) before.push(child);
    else if (childIndex > index) after.push(child);
  });
  // The spacing after the bullet stays between the dash and the box, as typed.
  const markerSpace =
    typeof item.attrs.space === "string" && item.attrs.space ? item.attrs.space : " ";
  const task = schema.nodes.taskItem!.create(
    { checked, indent: item.attrs.indent, markerSpace },
    item.content,
  );
  const lists = [
    ...(before.length > 0 ? [list.copy(Fragment.from(before))] : []),
    schema.nodes.taskList!.create(null, task),
    ...(after.length > 0 ? [list.copy(Fragment.from(after))] : []),
  ];
  const listStart = $pos.before(-2);
  tr.replaceWith(listStart, listStart + list.nodeSize, lists);
  // Into the task list, its item and its paragraph.
  const caret = listStart + (before.length > 0 ? lists[0]!.nodeSize : 0) + 3;
  tr.setSelection(TextSelection.create(tr.doc, caret));
}

function listItemTypeAt($pos: ResolvedPos): "listItem" | "taskItem" | null {
  const name = $pos.depth > 1 ? $pos.node(-1).type.name : null;
  return name === "listItem" || name === "taskItem" ? name : null;
}

/**
 * Backspace at the start of an item's text leaves one level of nesting, or
 * the list itself at the top, written at its new depth. At the start of a
 * line right after a list it joins that line onto the list's last line.
 * Tiptap's list keymap, which StarterKit loads, does both by moving nodes
 * without touching their indent or marker, so the composer turns it off.
 */
export function backspaceAcrossList(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const itemType = listItemTypeAt($from);
  if (itemType && $from.index(-1) === 0) {
    const lift: Command = ({ commands, tr }) => {
      const moved = commands.liftListItem(itemType);
      if (moved) alignListItemWithSiblings(tr, itemType);
      return moved;
    };
    // Not `can()` first: a dry run of the lift skips the schema check, so it
    // says yes to a task under a bullet, which has no list to lift into. Its
    // text joins the line above instead.
    return editor.chain().command(lift).run() || joinBackward(state, editor.view.dispatch);
  }
  const before = $from.depth === 1 ? $from.node(0).maybeChild($from.index(0) - 1) : null;
  if (before && LIST_NODE_NAMES.has(before.type.name) && $from.parent.type.name !== "codeBlock") {
    return joinTextblockBackward(state, editor.view.dispatch);
  }
  return false;
}

/**
 * Delete at the end of a line next to list structure pulls the next line's
 * text up onto it. Tiptap's default would instead nest the next item, or a
 * whole list, under this one at its old indent. Before a fence, anywhere, it
 * does nothing: pulling the code into the line would drop the fence from the
 * draft and leave the rest of the code as stray lines.
 */
export function deleteAcrossList(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.depth === 0) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  const next = Selection.findFrom(state.doc.resolve($from.after()), 1, true);
  if (!next) return false;
  if (next.$from.parent.type.name === "codeBlock") return $from.parent.type.name !== "codeBlock";
  if (!listItemTypeAt($from) && !listItemTypeAt(next.$from)) return false;
  return joinTextblockForward(state, editor.view.dispatch);
}

/** The literal prefix an item serializes to. Empty items keep their exact spacing. */
function listItemPrefix(item: ProseMirrorNode, empty: boolean): string {
  const attrs = item.attrs as Record<string, unknown>;
  const indent = typeof attrs.indent === "string" ? attrs.indent : "";
  if (item.type.name === "taskItem") {
    const markerSpace = typeof attrs.markerSpace === "string" ? attrs.markerSpace : " ";
    const contentSpace =
      typeof attrs.contentSpace === "string"
        ? attrs.contentSpace || (empty ? "" : " ")
        : empty
          ? ""
          : " ";
    return `${indent}-${markerSpace}[${attrs.checked === true ? "x" : " "}]${contentSpace}`;
  }
  const marker = typeof attrs.marker === "string" && attrs.marker ? attrs.marker : "-";
  // A bare `-` keeps its missing space only while the item is empty: once it
  // has text, `-text` would not be a list line any more.
  const space =
    typeof attrs.space === "string" ? attrs.space || (empty ? "" : " ") : empty ? "" : " ";
  return `${indent}${marker}${space}`;
}

function walkList(list: ProseMirrorNode, listStart: number, acc: RichAccumulator): void {
  let itemPos = listStart + 1;
  let firstItem = true;
  list.content.forEach((item) => {
    // Sibling items are separated by one newline in every coordinate space.
    if (!firstItem) pushBreakRun(acc);
    firstItem = false;
    const itemContentStart = itemPos + 1;
    const first = item.firstChild;
    const empty = first?.type.name === "paragraph" && first.content.childCount === 0;
    const prefix = listItemPrefix(item, empty);
    // The marker owns no document characters; every prefix offset clamps
    // to the start of the item text, exactly like style markers.
    acc.runs.push({
      kind: "prefix",
      flatStart: acc.flat,
      docLen: 0,
      collapsedLen: prefix.length,
      mdLen: prefix.length,
      openLen: 0,
      closeLen: 0,
      pmPos: itemContentStart + 1,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
    });
    acc.value += prefix;
    acc.collapsed += prefix.length;
    acc.md += prefix.length;
    let childPos = itemContentStart;
    let firstBlock = true;
    item.content.forEach((child) => {
      if (!firstBlock) pushBreakRun(acc);
      firstBlock = false;
      if (LIST_NODE_NAMES.has(child.type.name)) {
        walkList(child, childPos, acc);
      } else if (child.type.name === "paragraph") {
        appendInlineRuns(child, childPos + 1, acc);
      }
      childPos += child.nodeSize;
    });
    itemPos += item.nodeSize;
  });
}

/**
 * A fence becomes one run whose open and close lengths are the delimiters, so
 * every cursor rule that already clamps out of a style marker clamps out of a
 * fence too. `nodeName` keeps the marker decorations off it: a code block is
 * drawn as a block, not revealed a character at a time.
 *
 * The code is literal text in the editor, but the draft store still counts a
 * chip's source in it as one cursor position, as it does everywhere. So the
 * run splits at each chip source, which spans its characters in the document
 * and one position in the collapsed space.
 */
function appendCodeBlockRun(
  block: ProseMirrorNode,
  pmPos: number,
  followed: boolean,
  acc: RichAccumulator,
): void {
  const { open, content, close } = codeBlockSource(block, followed);
  const pieces = content
    ? splitPromptIntoComposerSegments(content).map((segment) =>
        segment.type === "text"
          ? { length: segment.text.length, collapsedLen: segment.text.length }
          : { length: segment.source.length, collapsedLen: 1 },
      )
    : [{ length: 0, collapsedLen: 0 }];
  let offset = 0;
  pieces.forEach((piece, index) => {
    const openLen = index === 0 ? open.length : 0;
    const closeLen = index === pieces.length - 1 ? close.length : 0;
    const collapsedLen = openLen + piece.collapsedLen + closeLen;
    const mdLen = openLen + piece.length + closeLen;
    acc.runs.push({
      kind: "text",
      flatStart: acc.flat,
      docLen: piece.length,
      collapsedLen,
      mdLen,
      openLen,
      closeLen,
      pmPos: pmPos + offset,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
      nodeName: "codeBlock",
    });
    offset += piece.length;
    acc.flat += piece.length;
    acc.collapsed += collapsedLen;
    acc.md += mdLen;
  });
  acc.value += open + content + close;
}

/** Each paragraph of a quote is one source line behind the quote's prefix. */
function walkBlockquote(quote: ProseMirrorNode, quoteStart: number, acc: RichAccumulator): void {
  const attrs = quote.attrs as Record<string, unknown>;
  const prefix = typeof attrs.prefix === "string" ? attrs.prefix : "> ";
  let childPos = quoteStart + 1;
  let firstLine = true;
  quote.content.forEach((child) => {
    if (!firstLine) pushBreakRun(acc);
    firstLine = false;
    acc.runs.push({
      kind: "prefix",
      flatStart: acc.flat,
      docLen: 0,
      collapsedLen: prefix.length,
      mdLen: prefix.length,
      openLen: 0,
      closeLen: 0,
      pmPos: childPos + 1,
      mdStart: acc.md,
      collapsedStart: acc.collapsed,
    });
    acc.value += prefix;
    acc.collapsed += prefix.length;
    acc.md += prefix.length;
    if (child.type.name === "paragraph") appendInlineRuns(child, childPos + 1, acc);
    childPos += child.nodeSize;
  });
}

/**
 * The stored Markdown of a selection, as copy and cut put it on the clipboard.
 * A slice holds only the content of the blocks the ends share, so items or
 * quote lines arrive without the list or quote that writes their markers. The
 * shared block is put back around them, and an item's list around it.
 */
export function serializeSelection(doc: ProseMirrorNode, from: number, to: number): string {
  const slice = doc.slice(from, to);
  const $from = doc.resolve(from);
  let depth = $from.sharedDepth(to);
  let content: Fragment | ProseMirrorNode = slice.content;
  if (slice.content.firstChild?.isInline) {
    content = doc.type.schema.nodes.paragraph!.create(null, slice.content);
  } else {
    while (depth > 0) {
      const shared = $from.node(depth);
      content = shared.copy(Fragment.from(content));
      if (!LIST_ITEM_NODE_NAMES.has(shared.type.name)) break;
      depth -= 1;
    }
  }
  return serializeEditorDoc(doc.type.create(null, content)).value;
}

export function serializeEditorDoc(doc: ProseMirrorNode): RichDocMap {
  const acc: RichAccumulator = { runs: [], value: "", flat: 0, collapsed: 0, md: 0 };
  const blocks: ProseMirrorNode[] = [];
  doc.content.forEach((node) => {
    blocks.push(node);
  });

  let pmBlockStart = 0;
  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0 && !isTrailingLineAfterRule(doc, blockIndex)) pushBreakRun(acc);
    if (LIST_NODE_NAMES.has(block.type.name)) {
      walkList(block, pmBlockStart, acc);
    } else if (block.type.name === "codeBlock") {
      appendCodeBlockRun(block, pmBlockStart + 1, blockIndex < blocks.length - 1, acc);
    } else if (block.type.name === "blockquote") {
      walkBlockquote(block, pmBlockStart, acc);
    } else if (block.type.name === "heading") {
      const attrs = block.attrs as Record<string, unknown>;
      const level = typeof attrs.level === "number" ? attrs.level : 1;
      const space = typeof attrs.space === "string" ? attrs.space : " ";
      const prefix = `${"#".repeat(level)}${space}`;
      acc.runs.push({
        kind: "prefix",
        flatStart: acc.flat,
        docLen: 0,
        collapsedLen: prefix.length,
        mdLen: prefix.length,
        openLen: 0,
        closeLen: 0,
        pmPos: pmBlockStart + 1,
        mdStart: acc.md,
        collapsedStart: acc.collapsed,
      });
      acc.value += prefix;
      acc.collapsed += prefix.length;
      acc.md += prefix.length;
      appendInlineRuns(block, pmBlockStart + 1, acc);
    } else if (block.type.name === "horizontalRule") {
      const attrs = block.attrs as Record<string, unknown>;
      const source = typeof attrs.source === "string" && attrs.source ? attrs.source : "---";
      acc.runs.push({
        kind: "prefix",
        flatStart: acc.flat,
        docLen: 0,
        collapsedLen: source.length,
        mdLen: source.length,
        openLen: 0,
        closeLen: 0,
        pmPos: pmBlockStart + block.nodeSize,
        mdStart: acc.md,
        collapsedStart: acc.collapsed,
      });
      acc.value += source;
      acc.collapsed += source.length;
      acc.md += source.length;
    } else if (block.type.name === "paragraph") {
      appendInlineRuns(block, pmBlockStart + 1, acc);
    }
    pmBlockStart += block.nodeSize;
  });

  return {
    value: acc.value,
    runs: acc.runs,
    docLength: acc.flat,
    contextIds: Array.from(new Set(collectInlineContextIds(acc.value))),
  };
}

function lastRunEnd(map: RichDocMap, space: "collapsed" | "md"): number {
  const last = map.runs[map.runs.length - 1];
  if (!last) return 0;
  return space === "collapsed"
    ? last.collapsedStart + last.collapsedLen
    : last.mdStart + last.mdLen;
}

/**
 * The end of a run belongs to the next run, which is how the end of `**bold**`
 * lands after its markers. A fence is the exception: its close is a line of
 * its own, so the end of the code stays inside the block rather than jumping
 * past the closing fence. Inline marks keep their trailing position.
 */
function runOwnsOffset(run: RichRun, flatOffset: number): boolean {
  const end = run.flatStart + run.docLen;
  return flatOffset < end || (flatOffset === end && run.nodeName === "codeBlock");
}

export function flatToCollapsed(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (runOwnsOffset(run, bounded)) {
      if (run.kind === "text" || run.kind === "token") {
        // A chip's source in a fence spans its characters but one position.
        const within = Math.min(
          bounded - run.flatStart,
          run.collapsedLen - run.openLen - run.closeLen,
        );
        return run.collapsedStart + run.openLen + within;
      }
      return run.collapsedStart + (bounded - run.flatStart);
    }
  }
  return lastRunEnd(map, "collapsed");
}

export function flatToMarkdown(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (runOwnsOffset(run, bounded)) {
      if (run.kind === "text" || run.kind === "token") {
        return run.mdStart + run.openLen + (bounded - run.flatStart);
      }
      return run.mdStart + (bounded - run.flatStart);
    }
  }
  return lastRunEnd(map, "md");
}

export function collapsedToFlat(map: RichDocMap, collapsedOffset: number): number {
  for (const run of map.runs) {
    if (collapsedOffset < run.collapsedStart + run.collapsedLen) {
      // Checkbox prefixes and style markers are shown, never edited: every
      // offset inside them clamps to the adjacent document position.
      if (run.kind === "prefix") return run.flatStart;
      if (run.kind === "text" || run.kind === "token") {
        const within = collapsedOffset - run.collapsedStart;
        const contentLen = run.collapsedLen - run.openLen - run.closeLen;
        // Marker characters clamp to the styled edge: they are shown, never edited.
        if (within <= run.openLen) return run.flatStart;
        if (within >= run.openLen + contentLen) return run.flatStart + run.docLen;
        return run.flatStart + (within - run.openLen);
      }
      return run.flatStart + (collapsedOffset - run.collapsedStart);
    }
  }
  return map.docLength;
}

export function flatToPm(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded < run.flatStart + run.docLen) {
      return run.pmPos + (bounded - run.flatStart);
    }
  }
  const last = map.runs[map.runs.length - 1];
  if (!last) return 1;
  return last.pmPos + last.docLen;
}

export function pmToFlat(map: RichDocMap, pmPos: number): number {
  for (const run of map.runs) {
    if (pmPos >= run.pmPos && pmPos <= run.pmPos + run.docLen) {
      // A position on a chip's trailing edge belongs after the chip.
      if (run.kind === "token" && pmPos === run.pmPos + run.docLen) {
        return run.flatStart + run.docLen;
      }
      return run.flatStart + Math.min(pmPos - run.pmPos, run.docLen);
    }
  }
  // A paragraph boundary position belongs to the newline between paragraphs.
  let best = 0;
  for (const run of map.runs) {
    if (run.pmPos <= pmPos) best = run.flatStart + run.docLen;
  }
  return Math.max(0, Math.min(best, map.docLength));
}

// ── Caret stops at styled edges ────────────────────────────────────────────
//
// Markers are decorations, not text, so the position where styled text meets
// unstyled text (or a paragraph edge) is a single document position. The
// caret gets two stops there: one that types with the marks before the edge
// and one that types with the marks after it. Stored marks pick the stop, and
// the revealed markers render on the matching side of the caret, so a pasted
// `**bold**` at the start of a line can still be typed in front of.

function styledEdge(state: EditorState) {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.inlineContent) return null;
  const before = $from.nodeBefore?.marks ?? Mark.none;
  const after = $from.nodeAfter?.marks ?? Mark.none;
  if (Mark.sameSet(before, after)) return null;
  return { before, after, current: state.storedMarks ?? $from.marks() };
}

/** True when the caret sits on a styled edge and types with the marks before it. */
export function caretTakesMarksBefore(state: EditorState): boolean {
  const edge = styledEdge(state);
  return edge !== null && Mark.sameSet(edge.current, edge.before);
}

/**
 * Moves the caret to the other stop of the styled edge it sits on, toward
 * `direction`. Returns null when there is no stop to take, so the arrow key
 * moves the caret as usual.
 */
export function stepCaretAcrossStyledEdge(
  state: EditorState,
  direction: -1 | 1,
): Transaction | null {
  const edge = styledEdge(state);
  if (!edge) return null;
  // Marks the user toggled by hand (neither stop) are theirs: move as usual.
  if (!Mark.sameSet(edge.current, edge.before) && !Mark.sameSet(edge.current, edge.after)) {
    return null;
  }
  const target = direction === -1 ? edge.before : edge.after;
  if (Mark.sameSet(edge.current, target)) return null;
  return state.tr.setStoredMarks(target);
}
