import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Code } from "@tiptap/extension-code";
import { TaskItem } from "@tiptap/extension-task-item";
import { Extension } from "@tiptap/core";

import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
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
export const ComposerCodeExtension = Code.extend({ excludes: "code" });

// Keep an unfinished fence unfinished when restoring a draft. These attributes
// are Markdown metadata, not HTML attributes on pasted code blocks.
export const ComposerBlockAttributesExtension = Extension.create({
  name: "composer-block-attributes",
  addGlobalAttributes() {
    return [
      {
        types: ["codeBlock"],
        attributes: {
          fence: { default: "```", rendered: false },
          info: { default: null, rendered: false },
          closed: { default: true, rendered: false },
          openingNewline: { default: true, rendered: false },
          finalNewline: { default: false, rendered: false },
        },
      },
    ];
  },
});

/**
 * Task list items keep their exact source indent in an attribute so nesting
 * round-trips byte-identically. Checkbox case (`[X]`) normalizes to `[x]` —
 * the same fixed-point deal as `__bold__` becoming `**bold**`.
 */
export const ComposerTaskItemExtension = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      indent: { default: "" },
      markerSpace: { default: " " },
      contentSpace: { default: null },
    };
  },
}).configure({ nested: true });

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

type InlineJson = Record<string, unknown>;

interface DocLine {
  task: TaskLinePrefix | null;
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

interface PendingTaskItem extends TaskLinePrefix {
  content: InlineJson[];
  children: PendingTaskItem[];
}

function taskListJson(items: PendingTaskItem[]): InlineJson {
  return {
    type: "taskList",
    content: items.map((item) => ({
      type: "taskItem",
      attrs: {
        checked: item.checked,
        indent: item.indent,
        markerSpace: item.markerSpace,
        contentSpace: item.contentSpace,
      },
      content: [
        { type: "paragraph", content: item.content },
        ...(item.children.length > 0 ? [taskListJson(item.children)] : []),
      ],
    })),
  };
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
  options?: { styling?: boolean },
): Record<string, unknown>[] {
  return buildBlocks(value, skillLabelFor, options?.styling ?? true, 0);
}

function buildBlocks(
  value: string,
  skillLabelFor: (name: string) => SkillMeta,
  styling: boolean,
  depth: number,
): Record<string, unknown>[] {
  if (!styling || depth >= 32) return buildInlineContent(value, skillLabelFor, { styling });
  const lines = value.split("\n");
  const blocks: Record<string, unknown>[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length)
      blocks.push(...buildInlineContent(pending.join("\n"), skillLabelFor, { styling }));
    pending = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = line.match(/^(`{3,}|~{3,})([^\n]*)$/);
    if (fence && (fence[1]![0] !== "`" || !fence[2]!.includes("`"))) {
      flush();
      const body: string[] = [];
      let closed = false;
      let finalNewline = false;
      const openingNewline = index < lines.length - 1;
      for (index += 1; index < lines.length; index += 1) {
        const next = lines[index]!;
        const closing = next.match(/^(`{3,}|~{3,})[ \t]*$/);
        if (closing && closing[1]![0] === fence[1]![0] && closing[1]!.length >= fence[1]!.length) {
          closed = true;
          finalNewline = body.length > 0;
          break;
        }
        body.push(next);
      }
      const text = body.join("\n");
      blocks.push({
        type: "codeBlock",
        attrs: {
          fence: fence[1],
          info: fence[2],
          language: fence[2]!.trim().split(/\s+/)[0] || null,
          closed,
          openingNewline,
          finalNewline,
        },
        content: text ? [{ type: "text", text }] : [],
      });
    } else if (/^> ?/.test(line)) {
      flush();
      const quoted = [line.replace(/^> ?/, "")];
      while (index + 1 < lines.length && /^> ?/.test(lines[index + 1]!)) {
        quoted.push(lines[++index]!.replace(/^> ?/, ""));
      }
      blocks.push({
        type: "blockquote",
        content: buildBlocks(quoted.join("\n"), skillLabelFor, styling, depth + 1),
      });
    } else {
      pending.push(line);
    }
  }
  flush();
  return blocks;
}

function buildInlineContent(
  value: string,
  skillLabelFor: (name: string) => SkillMeta,
  options?: { styling?: boolean },
): Record<string, unknown>[] {
  const styling = options?.styling ?? true;
  // Hide token source from the markdown parser, then restore the atoms with
  // the marks of their surrounding text. Choose a sentinel absent from input.
  let sentinel = "\uFFFC";
  for (let codePoint = 0xe000; value.includes(sentinel); codePoint += 1) {
    sentinel = String.fromCodePoint(codePoint);
  }
  const atoms: InlineJson[] = [];
  const text = splitPromptIntoComposerSegments(value)
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      atoms.push(atomJsonForSegment(segment, skillLabelFor));
      return sentinel;
    })
    .join("");
  let atomIndex = 0;
  const lines: DocLine[] = text.split("\n").map((line) => {
    const parsed = styling ? parseTaskPrefix(line) : null;
    const content = parsed ? line.slice(parsed.markerLength) : line;
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
    return { task: parsed?.prefix ?? null, inline };
  });

  // Pass 2: consecutive task lines group into (possibly nested) task lists
  // by indent prefix; everything else stays a paragraph.
  const blocks: Record<string, unknown>[] = [];
  let stack: { indent: string; items: PendingTaskItem[] }[] = [];
  const flushTasks = () => {
    if (stack.length > 0) {
      blocks.push(taskListJson(stack[0]!.items));
      stack = [];
    }
  };
  for (const line of lines) {
    if (!line.task) {
      flushTasks();
      blocks.push({ type: "paragraph", content: line.inline });
      continue;
    }
    const item: PendingTaskItem = {
      ...line.task,
      content: line.inline,
      children: [],
    };
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top) {
        // A leading indented item with no parent flattens but keeps indent.
        stack.push({ indent: item.indent, items: [] });
        continue;
      }
      if (top.indent === item.indent) {
        top.items.push(item);
        break;
      }
      if (top.indent !== "" && !item.indent.startsWith(top.indent)) {
        if (stack.length > 1) {
          stack.pop();
          continue;
        }
        top.indent = item.indent;
        top.items.push(item);
        break;
      }
      const parent = top.items[top.items.length - 1];
      if (!parent) {
        top.items.push(item);
        break;
      }
      parent.children.push(item);
      stack.push({ indent: item.indent, items: parent.children });
      break;
    }
  }
  flushTasks();
  return blocks;
}

export function buildDocJson(
  value: string,
  skillLabelFor: (name: string) => SkillMeta,
  options?: { styling?: boolean },
) {
  return { type: "doc", content: buildTiptapContent(value, skillLabelFor, options) };
}

export interface RichRun {
  kind: "text" | "token" | "break" | "prefix" | "suffix";
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

function appendMarker(
  acc: RichAccumulator,
  source: string,
  pmPos: number,
  kind: "prefix" | "suffix" = "prefix",
): void {
  if (!source) return;
  acc.runs.push({
    kind,
    flatStart: acc.flat,
    docLen: 0,
    collapsedLen: source.length,
    mdLen: source.length,
    openLen: 0,
    closeLen: 0,
    pmPos,
    mdStart: acc.md,
    collapsedStart: acc.collapsed,
  });
  acc.value += source;
  acc.collapsed += source.length;
  acc.md += source.length;
}

function walkTaskList(
  list: ProseMirrorNode,
  listStart: number,
  acc: RichAccumulator,
  quotePrefix = "",
): void {
  let itemPos = listStart + 1;
  let firstItem = true;
  list.content.forEach((item) => {
    // Sibling items are separated by one newline in every coordinate space.
    if (!firstItem) pushBreakRun(acc);
    firstItem = false;
    const itemContentStart = itemPos + 1;
    appendMarker(acc, quotePrefix, itemContentStart + 1);
    const first = item.firstChild;
    const empty = first?.type.name === "paragraph" && first.content.childCount === 0;
    const attrs = item.attrs as Record<string, unknown>;
    const indent = typeof attrs.indent === "string" ? attrs.indent : "";
    const markerSpace = typeof attrs.markerSpace === "string" ? attrs.markerSpace : " ";
    const contentSpace =
      typeof attrs.contentSpace === "string"
        ? attrs.contentSpace || (empty ? "" : " ")
        : empty
          ? ""
          : " ";
    const prefix = `${indent}-${markerSpace}[${attrs.checked === true ? "x" : " "}]${contentSpace}`;
    // The checkbox owns no document characters; every prefix offset clamps
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
      if (!firstBlock) {
        pushBreakRun(acc);
        if (child.type.name === "paragraph") appendMarker(acc, quotePrefix, childPos + 1);
      }
      firstBlock = false;
      if (child.type.name === "taskList") {
        walkTaskList(child, childPos, acc, quotePrefix);
      } else if (child.type.name === "paragraph") {
        appendInlineRuns(child, childPos + 1, acc);
      }
      childPos += child.nodeSize;
    });
    itemPos += item.nodeSize;
  });
}

function walkBlocks(
  container: ProseMirrorNode,
  start: number,
  acc: RichAccumulator,
  quotePrefix = "",
): void {
  let position = start;
  container.forEach((block, _offset, index) => {
    if (index > 0) pushBreakRun(acc);
    if (block.type.name === "blockquote") {
      walkBlocks(block, position + 1, acc, `${quotePrefix}> `);
    } else if (block.type.name === "taskList") {
      walkTaskList(block, position, acc, quotePrefix);
    } else if (block.type.name === "codeBlock") {
      const text = block.textContent;
      const storedFence = typeof block.attrs.fence === "string" ? block.attrs.fence : "```";
      const character = storedFence[0] === "~" ? "~" : "`";
      const runs = text.match(character === "`" ? /`+/g : /~+/g) ?? [];
      const fence = character.repeat(
        runs.reduce(
          (length, run) => Math.max(length, run.length + 1),
          Math.max(3, storedFence.length),
        ),
      );
      const info =
        typeof block.attrs.info === "string" ? block.attrs.info : block.attrs.language || "";
      const openingNewline =
        block.attrs.openingNewline !== false || text || block.attrs.closed !== false ? "\n" : "";
      appendMarker(acc, `${quotePrefix}${fence}${info}${openingNewline}`, position + 1);
      let offset = 0;
      text.split("\n").forEach((line, lineIndex) => {
        if (lineIndex > 0) {
          pushBreakRun(acc, position + offset);
          appendMarker(acc, quotePrefix, position + offset + 1);
        } else if (
          text ||
          block.attrs.finalNewline ||
          (block.attrs.closed === false && block.attrs.openingNewline !== false)
        ) {
          appendMarker(acc, quotePrefix, position + 1);
        }
        acc.runs.push({
          kind: "text",
          flatStart: acc.flat,
          docLen: line.length,
          collapsedLen: line.length,
          mdLen: line.length,
          openLen: 0,
          closeLen: 0,
          pmPos: position + 1 + offset,
          mdStart: acc.md,
          collapsedStart: acc.collapsed,
        });
        acc.value += line;
        acc.flat += line.length;
        acc.collapsed += line.length;
        acc.md += line.length;
        offset += line.length + 1;
      });
      // A code block followed by another block must have a closing fence even
      // if its source draft originally ended with an unfinished fence.
      if (block.attrs.closed !== false || index < container.childCount - 1) {
        const newline = text || block.attrs.finalNewline ? "\n" : "";
        appendMarker(acc, `${newline}${quotePrefix}${fence}`, position + 1 + text.length, "suffix");
      }
    } else if (block.type.name === "paragraph") {
      appendMarker(acc, quotePrefix, position + 1);
      appendInlineRuns(block, position + 1, acc);
    }
    position += block.nodeSize;
  });
}

export function serializeEditorDoc(doc: ProseMirrorNode): RichDocMap {
  const acc: RichAccumulator = { runs: [], value: "", flat: 0, collapsed: 0, md: 0 };
  walkBlocks(doc, 0, acc);

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
  if (last.kind === "suffix") return space === "collapsed" ? last.collapsedStart : last.mdStart;
  return space === "collapsed"
    ? last.collapsedStart + last.collapsedLen
    : last.mdStart + last.mdLen;
}

export function flatToCollapsed(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded < run.flatStart + run.docLen) {
      if (run.kind === "text" || run.kind === "token") {
        return run.collapsedStart + run.openLen + (bounded - run.flatStart);
      }
      return run.collapsedStart + (bounded - run.flatStart);
    }
  }
  return lastRunEnd(map, "collapsed");
}

export function flatToMarkdown(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded < run.flatStart + run.docLen) {
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
      if (run.kind === "prefix" || run.kind === "suffix") return run.flatStart;
      if (run.kind === "text" || run.kind === "token") {
        const within = collapsedOffset - run.collapsedStart;
        // Marker characters clamp to the styled edge: they are shown, never edited.
        if (within <= run.openLen) return run.flatStart;
        if (within >= run.openLen + run.docLen) return run.flatStart + run.docLen;
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
