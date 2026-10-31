import { joinBackward, joinTextblockBackward, joinTextblockForward } from "@tiptap/pm/commands";
import {
  Fragment,
  Mark,
  type MarkType,
  type Node as ProseMirrorNode,
  type ResolvedPos,
} from "@tiptap/pm/model";
import { Code } from "@tiptap/extension-code";
import { Blockquote } from "@tiptap/extension-blockquote";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Heading } from "@tiptap/extension-heading";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { Italic, starInputRegex, starPasteRegex } from "@tiptap/extension-italic";
import {
  type Command,
  type Editor,
  Extension,
  markInputRule,
  markPasteRule,
  mergeAttributes,
} from "@tiptap/core";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import {
  type EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";

import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import { nextOrderedMarkerText } from "~/composer-list-continuation";
import { parseInlineMarkdown, RICH_TEXT_DELIMITERS, type RichTextMark } from "~/composer-rich-text";
import { collectInlineContextIds } from "~/lib/composerContextReferences";
import { composerMathRanges } from "@t3tools/shared/composerInlineTokens";

export type SkillMeta = { label: string; description: string | null };

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

type CodePair = { from: number; to: number };

const codePairKey = new PluginKey<CodePair[]>("typedBacktickPairs");

// Input rules only see text before the caret, so filling an already typed
// pair needs a separate exit handler. Only typed pairs opt into that handler.
function codePairCaretPlugin(type: MarkType) {
  return new Plugin<CodePair[]>({
    key: codePairKey,
    state: {
      init: () => [],
      apply(tr, pairs) {
        const mapped = pairs.flatMap((pair) => {
          const from = tr.mapping.mapResult(pair.from, 1);
          const to = tr.mapping.mapResult(pair.to, -1);
          return from.deleted || to.deleted ? [] : [{ from: from.pos, to: to.pos }];
        });
        const typed = tr.getMeta(codePairKey) as CodePair | undefined;
        return typed ? [...mapped, typed] : mapped;
      },
    },
    props: {
      handleTextInput(view, from, to, text, insert) {
        if (view.composing || from !== to || text !== "`") return false;
        const $from = view.state.doc.resolve(from);
        if (
          !$from.parent.isTextblock ||
          $from.parent.type.spec.code ||
          !/(^|[^`])`$/.test($from.nodeBefore?.text ?? "")
        ) {
          return false;
        }
        view.dispatch(insert().setMeta(codePairKey, { from: from - 1, to: from + 1 }));
        return true;
      },
    },
    appendTransaction(transactions, oldState, state) {
      if (!state.selection.empty || oldState.selection.from === state.selection.from) return null;
      if (transactions.some((tr) => tr.docChanged)) return null;
      const pair = codePairKey.getState(state)?.find(({ to }) => to === state.selection.from);
      if (!pair) return null;
      const $start = state.doc.resolve(pair.from);
      const $end = state.selection.$from;
      if (!$start.sameParent($end) || $start.parent.type.spec.code) return null;
      if (
        $start.nodeBefore?.text?.endsWith("`") ||
        $end.nodeAfter?.text?.startsWith("`") ||
        !/^`[^`]+`$/.test(state.doc.textBetween(pair.from, pair.to))
      ) {
        return null;
      }
      let plain = true;
      state.doc.nodesBetween(pair.from, pair.to, (node) => {
        if (node.isInline && (!node.isText || node.marks.length > 0)) plain = false;
      });
      if (!plain) return null;
      const tr = state.tr.delete(pair.to - 1, pair.to).delete(pair.from, pair.from + 1);
      tr.addMark(pair.from, pair.to - 2, type.create());
      tr.setSelection(TextSelection.create(tr.doc, pair.to - 2));
      tr.removeStoredMark(type);
      return tr;
    },
  });
}

/**
 * Tiptap's code mark excludes every other mark, which rejects the `bold+code`
 * spans markdown like `**\`x\`**` parses into and drops the whole insert.
 */
export const ComposerCodeExtension = Code.extend({
  excludes: "code",
  // The forward arrow leaves code through the caret stops at styled edges, so
  // the stock exit (inserting a space at the end of a line) is not needed.
  exitable: false,
  // Code reads left to right inside an Arabic or Hebrew line, and the isolate
  // keeps its punctuation from trading places with the text around it.
  addOptions() {
    return { ...this.parent!(), HTMLAttributes: { dir: "ltr" } };
  },
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), codePairCaretPlugin(this.type)];
  },
});

/**
 * The composer writes italic as `*text*`, so it keeps only the `*` shortcuts.
 * Tiptap's `_text_` rules fire on the `_` in names like `node_modules` and
 * italicize back to an earlier `_build`, even one inside a code span.
 */
export const ComposerItalicExtension = Italic.extend({
  addInputRules() {
    return [markInputRule({ find: starInputRegex, type: this.type })];
  },
  addPasteRules() {
    return [markPasteRule({ find: starPasteRegex, type: this.type })];
  },
});

/**
 * Mod+B bolds selected text only. Without a selection Tiptap would toggle bold
 * for the next typed text, which users hit by accident when they mean the
 * sidebar toggle. Runs ahead of the Bold extension and swallows the chord.
 */
export const ComposerBoldSelectionOnlyExtension = Extension.create({
  name: "composerBoldSelectionOnly",
  priority: 1000,
  addKeyboardShortcuts() {
    const ignoreWithoutSelection = () => this.editor.state.selection.empty;
    return { "Mod-b": ignoreWithoutSelection, "Mod-B": ignoreWithoutSelection };
  },
});

/**
 * Tiptap's block chords can nest blocks inside quotes that the serializer cannot write,
 * silently dropping their text from stored drafts.
 */
function withoutBlockChords<Shortcuts extends Record<string, unknown>>(
  shortcuts: Shortcuts | undefined,
  drop: readonly string[],
): Shortcuts {
  return Object.fromEntries(
    Object.entries(shortcuts ?? {}).filter(([key]) => !drop.includes(key)),
  ) as Shortcuts;
}

// Markdown supports one paragraph followed by nested lists per item.
const LIST_ITEM_CONTENT = "paragraph list*";

/** Task lists come from `- [ ]` alone; Mod-Shift-9 would nest one in a quote. */
export const ComposerTaskListExtension = TaskList.extend({
  addKeyboardShortcuts() {
    return withoutBlockChords(this.parent?.(), ["Mod-Shift-9"]);
  },
});

/** Tiptap's nesting shortcuts leave indent unchanged, so rebuilding the draft undoes them. */
const LIST_NESTING_KEYS = ["Tab", "Shift-Tab"];

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

// Joining with the previous line would lose the fence and leave stray code lines.
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
  // Use a longer fence when code contains a closing fence.
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
  // Close before a following block so rebuilding does not absorb it as code.
  if (!close && followed) close = `\n${fence}`;
  return { open: `${fence}${language}${content ? "\n" : ""}`, content, close };
}

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
      Backspace: () => backspaceAcrossList(this.editor),
      Delete: () => deleteAcrossList(this.editor),
    };
  },
  // ProseMirror can reuse the parent list when only an item's marker changes.
  // Item metadata lets CSS resize its gutter through CommonMark's nine-digit limit.
  renderHTML({ node, HTMLAttributes }) {
    const marker = String(node.attrs.marker);
    return [
      "li",
      mergeAttributes(HTMLAttributes, {
        "data-marker": marker,
        "data-marker-width": Math.min(marker.length, 10),
      }),
      0,
    ];
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

const ComposerBlockquoteExtension = Blockquote.extend({
  content: "paragraph+",
  addAttributes() {
    return { ...this.parent?.(), prefix: { default: "> " } };
  },
  addKeyboardShortcuts() {
    return withoutBlockChords(this.parent?.(), ["Mod-Shift-b"]);
  },
});

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

const ComposerHeadingExtension = Heading.extend({
  addAttributes() {
    return { ...this.parent?.(), space: { default: " " } };
  },
  addKeyboardShortcuts() {
    return {};
  },
});

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

export function parseOpeningFence(line: string): { fence: string; language: string } | null {
  // Unlike `.`, `[^\n]` accepts the stored \r in CRLF lines.
  const match = /^(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!match) return null;
  const fence = match[1]!;
  const language = match[2]!;
  if (fence.startsWith("`") && language.includes("`")) return null;
  return { fence, language };
}

export function isClosingFence(line: string, fence: string): boolean {
  const match = /^(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  if (!match) return false;
  const run = match[1]!;
  return run[0] === fence[0] && run.length >= fence.length;
}

type ListLinePrefix =
  | ({ kind: "task" } & TaskLinePrefix)
  | { kind: "bullet" | "ordered"; indent: string; marker: string; space: string };

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

/** Null for a `$name` that is not one of the provider's skills: it stays editable text. */
function atomJsonForSegment(
  segment: Exclude<ReturnType<typeof splitPromptIntoComposerSegments>[number], { type: "text" }>,
  skillLabelFor: (name: string) => SkillMeta | null,
): InlineJson | null {
  if (segment.type === "mention") {
    return {
      type: "composer-mention",
      attrs: { path: segment.path, source: segment.source },
    };
  }
  if (segment.type === "skill") {
    const meta = skillLabelFor(segment.name);
    if (!meta) return null;
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

/** Keeps literalLength leading characters unstyled so path queries reach file search unchanged. */
export function buildTiptapContent(
  value: string,
  skillLabelFor: (name: string) => SkillMeta | null,
  options?: { styling?: boolean; blocks?: boolean; literalText?: boolean; literalLength?: number },
): Record<string, unknown>[] {
  if (options?.literalText) {
    return value.split("\n").map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    }));
  }
  const styling = options?.styling ?? true;
  const blockSyntax = styling && (options?.blocks ?? true);
  let sentinel = "\uFFFC";
  for (let codePoint = 0xe000; value.includes(sentinel); codePoint += 1) {
    sentinel = String.fromCodePoint(codePoint);
  }
  const atoms: InlineJson[] = [];
  const atomSources: string[] = [];
  const literal = value.slice(0, options?.literalLength ?? 0);
  const remainder = value.slice(literal.length);
  const formulas = composerMathRanges(remainder);
  let offset = 0;
  const chunks: Array<{ text: string } | { source: string }> = [];
  for (const formula of formulas) {
    chunks.push({ text: remainder.slice(offset, formula.start) }, { source: formula.source });
    offset = formula.end;
  }
  chunks.push({ text: remainder.slice(offset) });
  // Math stays editable source. Shield its commands and Markdown-like markers
  // from styling and context-chip parsing, then restore ordinary text nodes.
  const text = chunks
    .map((chunk) => {
      if ("source" in chunk) {
        atoms.push(textJsonForSpan(chunk.source, []));
        atomSources.push(chunk.source);
        return sentinel;
      }
      return splitPromptIntoComposerSegments(chunk.text)
        .map((segment) => {
          if (segment.type === "text") return segment.text;
          const atom = atomJsonForSegment(segment, skillLabelFor);
          if (!atom) return segment.source;
          atoms.push(atom);
          atomSources.push(segment.source);
          return sentinel;
        })
        .join("");
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
    if (index === 0 && literal) {
      entries.push({
        line: { list: null, inline: [textJsonForSpan(literal, []), ...buildInline(line)] },
      });
      continue;
    }
    const opening = blockSyntax ? parseOpeningFence(line) : null;
    if (!opening) {
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
  skillLabelFor: (name: string) => SkillMeta | null,
  options?: { styling?: boolean; literalText?: boolean },
) {
  const content = buildTiptapContent(value, skillLabelFor, options);
  if (content.at(-1)?.type === "horizontalRule") content.push({ type: "paragraph" });
  return { type: "doc", content };
}

export interface RichRun {
  kind: "text" | "token" | "break" | "prefix";
  /** Flat document offset (atoms count 1, markers excluded). */
  flatStart: number;
  docLen: number;
  /** Markdown length (tokens expand to their source). */
  mdLen: number;
  openLen: number;
  closeLen: number;
  pmPos: number;
  mdStart: number;
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
  md: number;
}

function pushBreakRun(acc: RichAccumulator, position?: number): void {
  const previous = acc.runs[acc.runs.length - 1];
  const pmPos = position ?? (previous ? previous.pmPos + previous.docLen : 1);
  acc.runs.push({
    kind: "break",
    flatStart: acc.flat,
    docLen: 1,
    mdLen: 1,
    openLen: 0,
    closeLen: 0,
    pmPos,
    mdStart: acc.md,
  });
  acc.value += "\n";
  acc.flat += 1;
  acc.md += 1;
}

// Separate prose from quotes to avoid lazy continuation; an empty paragraph already separates them.
function needsBlankLineAfterQuote(previous: ProseMirrorNode, block: ProseMirrorNode): boolean {
  return (
    previous.type.name === "blockquote" && block.type.name === "paragraph" && block.content.size > 0
  );
}

// Blank-line runs own no document characters; offsets clamp to the paragraph start.
function pushBlankLineRun(acc: RichAccumulator, pmPos: number): void {
  acc.runs.push({
    kind: "prefix",
    flatStart: acc.flat,
    docLen: 0,
    mdLen: 1,
    openLen: 0,
    closeLen: 0,
    pmPos,
    mdStart: acc.md,
  });
  acc.value += "\n";
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
    const text = child.text!;
    const start = text.length - text.trimStart().length;
    const end = Math.max(start, text.trimEnd().length);
    let offset = 0;
    for (const boundary of [start, end, text.length]) {
      if (boundary > offset) children.push(child.cut(offset, boundary));
      offset = boundary;
    }
  });
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
    acc.runs.push({
      kind: child.isText ? "text" : "token",
      flatStart: acc.flat,
      docLen,
      mdLen: mdText.length,
      openLen: open.length,
      closeLen: close.length,
      pmPos,
      mdStart: acc.md,
      ...(child.isText ? {} : { nodeName: child.type.name }),
    });
    acc.value += mdText;
    acc.flat += docLen;
    acc.md += mdText.length;
  });
  if (children.length === 0) {
    acc.runs.push({
      kind: "text",
      flatStart: acc.flat,
      docLen: 0,
      mdLen: 0,
      openLen: 0,
      closeLen: 0,
      pmPos: contentStart,
      mdStart: acc.md,
    });
  }
}

const LIST_NODE_NAMES = new Set(["taskList", "bulletList", "orderedList"]);
const LIST_ITEM_NODE_NAMES = new Set(["taskItem", "listItem"]);

// Tiptap leaves indent and marker attributes unchanged when moving items; rebuilding would undo the move.
function alignListItemWithSiblings(tr: Transaction, itemType: string): void {
  const $pos = tr.selection.$from;
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

export function splitOrLiftListItem(editor: Editor): boolean {
  const $from = editor.state.selection.$from;
  const itemType = listItemTypeAt($from);
  if (!itemType) return false;
  const empty = $from.parent.content.size === 0;
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
  const caret = listStart + (before.length > 0 ? lists[0]!.nodeSize : 0) + 3;
  tr.setSelection(TextSelection.create(tr.doc, caret));
}

function listItemTypeAt($pos: ResolvedPos): "listItem" | "taskItem" | null {
  const name = $pos.depth > 1 ? $pos.node(-1).type.name : null;
  return name === "listItem" || name === "taskItem" ? name : null;
}

/**
 * Tiptap's list keymap, which StarterKit loads, does both by moving nodes
 * without touching their indent or marker, so the composer turns it off.
 */
function backspaceAcrossList(editor: Editor): boolean {
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
    // can() skips the schema check and can accept tasks with no parent list to lift into.
    return editor.chain().command(lift).run() || joinBackward(state, editor.view.dispatch);
  }
  const before = $from.depth === 1 ? $from.node(0).maybeChild($from.index(0) - 1) : null;
  if (before && LIST_NODE_NAMES.has(before.type.name) && $from.parent.type.name !== "codeBlock") {
    return joinTextblockBackward(state, editor.view.dispatch);
  }
  return false;
}

/**
 * Tiptap's default would instead nest the next item, or a whole list, under
 * this one at its old indent.
 */
function deleteAcrossList(editor: Editor): boolean {
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
  const space =
    typeof attrs.space === "string" ? attrs.space || (empty ? "" : " ") : empty ? "" : " ";
  return `${indent}${marker}${space}`;
}

function walkList(list: ProseMirrorNode, listStart: number, acc: RichAccumulator): void {
  let itemPos = listStart + 1;
  let firstItem = true;
  list.content.forEach((item) => {
    if (!firstItem) pushBreakRun(acc);
    firstItem = false;
    const itemContentStart = itemPos + 1;
    const first = item.firstChild;
    const empty = first?.type.name === "paragraph" && first.content.childCount === 0;
    const prefix = listItemPrefix(item, empty);
    acc.runs.push({
      kind: "prefix",
      flatStart: acc.flat,
      docLen: 0,
      mdLen: prefix.length,
      openLen: 0,
      closeLen: 0,
      pmPos: itemContentStart + 1,
      mdStart: acc.md,
    });
    acc.value += prefix;
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

function appendCodeBlockRun(
  block: ProseMirrorNode,
  pmPos: number,
  followed: boolean,
  acc: RichAccumulator,
): void {
  const { open, content, close } = codeBlockSource(block, followed);
  const mdLen = open.length + content.length + close.length;
  acc.runs.push({
    kind: "text",
    flatStart: acc.flat,
    docLen: content.length,
    mdLen,
    openLen: open.length,
    closeLen: close.length,
    pmPos,
    mdStart: acc.md,
    nodeName: "codeBlock",
  });
  acc.flat += content.length;
  acc.md += mdLen;
  acc.value += open + content + close;
}

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
      mdLen: prefix.length,
      openLen: 0,
      closeLen: 0,
      pmPos: childPos + 1,
      mdStart: acc.md,
    });
    acc.value += prefix;
    acc.md += prefix.length;
    if (child.type.name === "paragraph") appendInlineRuns(child, childPos + 1, acc);
    childPos += child.nodeSize;
  });
}

/** Restores list and quote markers omitted by slices that contain only shared-block content. */
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
  const acc: RichAccumulator = { runs: [], value: "", flat: 0, md: 0 };
  const blocks: ProseMirrorNode[] = [];
  doc.content.forEach((node) => {
    blocks.push(node);
  });

  let pmBlockStart = 0;
  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0 && !isTrailingLineAfterRule(doc, blockIndex)) pushBreakRun(acc);
    if (blockIndex > 0 && needsBlankLineAfterQuote(blocks[blockIndex - 1]!, block)) {
      pushBlankLineRun(acc, pmBlockStart + 1);
    }
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
        mdLen: prefix.length,
        openLen: 0,
        closeLen: 0,
        pmPos: pmBlockStart + 1,
        mdStart: acc.md,
      });
      acc.value += prefix;
      acc.md += prefix.length;
      appendInlineRuns(block, pmBlockStart + 1, acc);
    } else if (block.type.name === "horizontalRule") {
      const attrs = block.attrs as Record<string, unknown>;
      const source = typeof attrs.source === "string" && attrs.source ? attrs.source : "---";
      acc.runs.push({
        kind: "prefix",
        flatStart: acc.flat,
        docLen: 0,
        mdLen: source.length,
        openLen: 0,
        closeLen: 0,
        pmPos: pmBlockStart + block.nodeSize,
        mdStart: acc.md,
      });
      acc.value += source;
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

export interface SkillChipReplacement {
  from: number;
  to: number;
  node: ProseMirrorNode;
}

/**
 * Use the same Markdown token boundaries as draft restoration. Apply edits
 * last-first so positions stay valid and unrelated citation nodes keep their keys.
 */
export function skillChipReplacements(
  doc: ProseMirrorNode,
  skillLabelFor: (name: string) => SkillMeta | null,
): SkillChipReplacement[] {
  const schema = doc.type.schema;
  const skillType = schema.nodes["composer-skill"];
  if (!skillType) return [];
  const replacements: SkillChipReplacement[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== skillType) return;
    const name = typeof node.attrs.skillName === "string" ? node.attrs.skillName : "";
    if (name && !skillLabelFor(name)) {
      replacements.push({
        from: pos,
        to: pos + node.nodeSize,
        node: schema.text(readAtomSource(node), node.marks),
      });
    }
  });
  const map = serializeEditorDoc(doc);
  let end = 0;
  for (const segment of splitPromptIntoComposerSegments(map.value)) {
    const start = end;
    end += segment.type === "text" ? segment.text.length : segment.source.length;
    if (segment.type !== "skill") continue;
    const meta = skillLabelFor(segment.name);
    if (!meta) continue;
    // Only text needs converting; an existing chip is a token run.
    const run = map.runs.find(
      (candidate) =>
        candidate.kind === "text" &&
        candidate.nodeName !== "codeBlock" &&
        start >= candidate.mdStart + candidate.openLen &&
        end <= candidate.mdStart + candidate.openLen + candidate.docLen,
    );
    if (!run) continue;
    const from = run.pmPos + (start - run.mdStart - run.openLen);
    replacements.push({
      from,
      to: from + segment.source.length,
      node: skillType.create(
        { skillName: segment.name, skillLabel: meta.label, skillDescription: meta.description },
        null,
        doc.nodeAt(from)?.marks,
      ),
    });
  }
  return replacements.sort((left, right) => right.from - left.from);
}

// Run ends belong to the next run, except code ends must stay inside their closing fence.
function runOwnsOffset(run: RichRun, flatOffset: number): boolean {
  const end = run.flatStart + run.docLen;
  return flatOffset < end || (flatOffset === end && run.nodeName === "codeBlock");
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
  const last = map.runs[map.runs.length - 1];
  return last ? last.mdStart + last.mdLen : 0;
}

export function markdownToFlat(map: RichDocMap, markdownOffset: number): number {
  for (const run of map.runs) {
    if (markdownOffset < run.mdStart + run.mdLen) {
      if (run.kind === "prefix") return run.flatStart;
      if (run.kind === "text" || run.kind === "token") {
        const within = markdownOffset - run.mdStart;
        if (within <= run.openLen) return run.flatStart;
        // A chip is one document position however long its source is.
        if (run.kind === "token" || within >= run.openLen + run.docLen) {
          return run.flatStart + run.docLen;
        }
        return run.flatStart + (within - run.openLen);
      }
      return run.flatStart + (markdownOffset - run.mdStart);
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
      if (run.kind === "token" && pmPos === run.pmPos + run.docLen) {
        return run.flatStart + run.docLen;
      }
      return run.flatStart + Math.min(pmPos - run.pmPos, run.docLen);
    }
  }
  let best = 0;
  for (const run of map.runs) {
    if (run.pmPos <= pmPos) best = run.flatStart + run.docLen;
  }
  return Math.max(0, Math.min(best, map.docLength));
}

// Styled boundaries need two caret stops at one position, one for each side's marks.

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

export function caretTakesMarksBefore(state: EditorState): boolean {
  const edge = styledEdge(state);
  return edge !== null && Mark.sameSet(edge.current, edge.before);
}

export function stepCaretAcrossStyledEdge(
  state: EditorState,
  direction: -1 | 1,
): Transaction | null {
  const edge = styledEdge(state);
  if (!edge) return null;
  if (!Mark.sameSet(edge.current, edge.before) && !Mark.sameSet(edge.current, edge.after)) {
    return null;
  }
  const target = direction === -1 ? edge.before : edge.after;
  if (Mark.sameSet(edge.current, target)) return null;
  return state.tr.setStoredMarks(target);
}
