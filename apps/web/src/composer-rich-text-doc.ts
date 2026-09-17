import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TaskItem } from "@tiptap/extension-task-item";

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
export const MARK_NESTING_ORDER: RichTextMark[] = ["strike", "bold", "italic", "code"];

export const MARK_TO_TIPTAP: Record<RichTextMark, string> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
};

export const TIPTAP_TO_MARK: Record<string, RichTextMark> = {
  bold: "bold",
  italic: "italic",
  strike: "strike",
  code: "code",
};

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
    };
  },
}).configure({ nested: true });

export function randomNodeKey(): string {
  return `tiptap-${Math.random().toString(36).slice(2)}`;
}

interface TaskLinePrefix {
  indent: string;
  checked: boolean;
}

function parseTaskPrefix(head: string): { prefix: TaskLinePrefix; markerLength: number } | null {
  const match = head.match(/^([ \t]*)-[ \t]+\[([ xX])\]/);
  if (!match) return null;
  const after = head.slice(match[0].length);
  if (after.length > 0 && after[0] !== " " && after[0] !== "\t") return null;
  return {
    prefix: {
      indent: match[1] ?? "",
      checked: (match[2] ?? " ").toLowerCase() === "x",
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

function pushSpans(inline: InlineJson[], text: string, styling: boolean): void {
  if (!styling) {
    // Plain-text mode: markers stay literal characters, no marks anywhere.
    if (text) inline.push({ type: "text", text });
    return;
  }
  for (const span of parseInlineMarkdown(text)) {
    inline.push(textJsonForSpan(span.text, span.marks));
  }
}

interface PendingTaskItem {
  checked: boolean;
  indent: string;
  content: InlineJson[];
  children: PendingTaskItem[];
}

function taskListJson(items: PendingTaskItem[]): InlineJson {
  return {
    type: "taskList",
    content: items.map((item) => ({
      type: "taskItem",
      attrs: { checked: item.checked, indent: item.indent },
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
  const styling = options?.styling ?? true;
  // Pass 1: the segment stream becomes lines. A line is a task line only
  // when its leading text — before any chip — is a complete `- [ ]` marker;
  // the marker is decided at a chip, a newline, or the end of input so a
  // partial marker (`- [ ]` + `foo`) can never commit early.
  const lines: DocLine[] = [{ task: null, inline: [] }];
  let head: string | null = "";
  const currentLine = () => lines[lines.length - 1]!;
  const endLine = () => {
    const line = currentLine();
    if (head !== null) {
      const parsed = styling ? parseTaskPrefix(head) : null;
      if (parsed) {
        line.task = parsed.prefix;
        pushSpans(line.inline, head.slice(parsed.markerLength).replace(/^[ \t]*/, ""), styling);
      } else {
        pushSpans(line.inline, head, styling);
      }
    }
    lines.push({ task: null, inline: [] });
    head = "";
  };
  const appendTextPiece = (piece: string) => {
    if (head !== null) {
      head += piece;
      return;
    }
    pushSpans(currentLine().inline, piece, styling);
  };

  for (const segment of splitPromptIntoComposerSegments(value)) {
    if (segment.type === "text") {
      const parts = segment.text.split("\n");
      parts.forEach((part, index) => {
        if (index > 0) endLine();
        appendTextPiece(part);
      });
    } else {
      if (head !== null) {
        const line = currentLine();
        const parsed = styling ? parseTaskPrefix(head) : null;
        if (parsed) {
          line.task = parsed.prefix;
          pushSpans(line.inline, head.slice(parsed.markerLength).replace(/^[ \t]*/, ""), styling);
        } else {
          pushSpans(line.inline, head, styling);
        }
        head = null;
      }
      currentLine().inline.push(atomJsonForSegment(segment, skillLabelFor));
    }
  }
  // Decide the final line. A trailing newline leaves a fresh empty line,
  // which endLine already pushed — drop the spare blank it would add.
  if (head !== null) {
    const line = currentLine();
    const parsed = styling ? parseTaskPrefix(head) : null;
    if (parsed) {
      line.task = parsed.prefix;
      pushSpans(line.inline, head.slice(parsed.markerLength).replace(/^[ \t]*/, ""), styling);
    } else {
      pushSpans(line.inline, head, styling);
    }
  } else if (lines.length > 1) {
    const last = lines[lines.length - 1]!;
    if (!last.task && last.inline.length === 0) lines.pop();
  }

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
      checked: line.task.checked,
      indent: line.task.indent,
      content: line.inline,
      children: [],
    };
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top) {
        // A leading indented item with no parent flattens but keeps indent.
        stack.push({ indent: "", items: [] });
        continue;
      }
      if (top.indent === item.indent) {
        top.items.push(item);
        break;
      }
      if (top.indent !== "" && !item.indent.startsWith(top.indent)) {
        stack.pop();
        continue;
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

function textRunDelimiters(marks: RichTextMark[]): { open: string; close: string } {
  let open = "";
  let close = "";
  for (const mark of [...marks].sort(
    (a, b) => MARK_NESTING_ORDER.indexOf(a) - MARK_NESTING_ORDER.indexOf(b),
  )) {
    const delimiter = RICH_TEXT_DELIMITERS[mark];
    open = open + delimiter;
    close = delimiter + close;
  }
  return { open, close };
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

function pushBreakRun(acc: RichAccumulator, pmPos: number): void {
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
  let inlineOffset = 0;
  container.content.forEach((child) => {
    const pmPos = contentStart + inlineOffset;
    if (child.isText && child.text) {
      const marks = (child.marks ?? [])
        .map((mark) => TIPTAP_TO_MARK[mark.type.name])
        .filter((mark): mark is RichTextMark => Boolean(mark));
      const { open, close } = textRunDelimiters(marks);
      const mdText = `${open}${child.text}${close}`;
      acc.runs.push({
        kind: "text",
        flatStart: acc.flat,
        docLen: child.text.length,
        collapsedLen: mdText.length,
        mdLen: mdText.length,
        openLen: open.length,
        closeLen: close.length,
        pmPos,
        mdStart: acc.md,
        collapsedStart: acc.collapsed,
      });
      acc.value += mdText;
      acc.flat += child.text.length;
      acc.collapsed += mdText.length;
      acc.md += mdText.length;
      inlineOffset += child.nodeSize;
    } else if (child.type.name === "hardBreak") {
      pushBreakRun(acc, pmPos);
      inlineOffset += child.nodeSize;
    } else if (child.isAtom || child.isInline) {
      const source = readAtomSource(child);
      acc.runs.push({
        kind: "token",
        flatStart: acc.flat,
        docLen: 1,
        collapsedLen: 1,
        mdLen: source.length,
        openLen: 0,
        closeLen: 0,
        pmPos,
        mdStart: acc.md,
        collapsedStart: acc.collapsed,
        nodeName: child.type.name,
      });
      acc.value += source;
      acc.flat += 1;
      acc.collapsed += 1;
      acc.md += source.length;
      inlineOffset += child.nodeSize;
    } else {
      inlineOffset += child.nodeSize;
    }
  });
}

function walkTaskList(list: ProseMirrorNode, listStart: number, acc: RichAccumulator): void {
  let itemPos = listStart + 1;
  let firstItem = true;
  list.content.forEach((item) => {
    // Sibling items are separated by one newline in every coordinate space.
    if (!firstItem) pushBreakRun(acc, itemPos - 1);
    firstItem = false;
    const itemContentStart = itemPos + 1;
    const first = item.firstChild;
    const empty =
      item.childCount === 1 && first?.type.name === "paragraph" && first.content.childCount === 0;
    const attrs = item.attrs as { checked?: unknown; indent?: unknown };
    const indent = typeof attrs.indent === "string" ? attrs.indent : "";
    const prefix = `${indent}- [${attrs.checked === true ? "x" : " "}]${empty ? "" : " "}`;
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
      if (!firstBlock) pushBreakRun(acc, childPos - 1);
      firstBlock = false;
      if (child.type.name === "taskList") {
        walkTaskList(child, childPos, acc);
      } else if (child.type.name === "paragraph") {
        appendInlineRuns(child, childPos + 1, acc);
      }
      childPos += child.nodeSize;
    });
    itemPos += item.nodeSize;
  });
}

export function serializeEditorDoc(doc: ProseMirrorNode): RichDocMap {
  const acc: RichAccumulator = { runs: [], value: "", flat: 0, collapsed: 0, md: 0 };
  const blocks: ProseMirrorNode[] = [];
  doc.content.forEach((node) => {
    blocks.push(node);
  });

  let pmBlockStart = 0;
  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0) pushBreakRun(acc, pmBlockStart - 1);
    if (block.type.name === "taskList") {
      walkTaskList(block, pmBlockStart, acc);
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

export function flatToCollapsed(map: RichDocMap, flatOffset: number): number {
  const bounded = Math.max(0, Math.min(flatOffset, map.docLength));
  for (const run of map.runs) {
    if (bounded < run.flatStart + run.docLen) {
      if (run.kind === "text") {
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
      if (run.kind === "text") {
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
      if (run.kind === "text") {
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
  if (!last) return 0;
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
