import { LIST_NODE_NAMES, alignListItemWithSiblings, buildTiptapContent, codeBlockSource, isTrailingLineAfterRule, listItemTypeAt } from "./composer-rich-text-doc-02-composer.ts";
import { MARK_NESTING_ORDER, TIPTAP_TO_MARK } from "./composer-rich-text-doc-03-skill.ts";
import type { RichAccumulator, RichDocMap, RichRun, SkillChipReplacement, SkillMeta } from "./composer-rich-text-doc-03-skill.ts";
import {
  Fragment,
  Mark,
  type MarkType,
  type Node as ProseMirrorNode,
  type ResolvedPos,
} from "@tiptap/pm/model";
import {
  type Command,
  type Editor,
  Extension,
  InputRule,
  markInputRule,
  markPasteRule,
  mergeAttributes,
} from "@tiptap/core";
import {
  type EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import { parseInlineMarkdown, RICH_TEXT_DELIMITERS, type RichTextMark } from "~/composer-rich-text";
import { collectInlineContextIds } from "~/lib/composerContextReferences";

export function buildDocJson(
  value: string,
  skillLabelFor: (name: string) => SkillMeta | null,
  options?: { styling?: boolean; literalText?: boolean },
) {
  const content = buildTiptapContent(value, skillLabelFor, options);
  if (content.at(-1)?.type === "horizontalRule") content.push({ type: "paragraph" });
  return { type: "doc", content };
}

export function readAtomSource(node: ProseMirrorNode): string {
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

export function pushBreakRun(acc: RichAccumulator, position?: number): void {
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
export function needsBlankLineAfterQuote(previous: ProseMirrorNode, block: ProseMirrorNode): boolean {
  return (
    previous.type.name === "blockquote" && block.type.name === "paragraph" && block.content.size > 0
  );
}

// Blank-line runs own no document characters; offsets clamp to the paragraph start.
export function pushBlankLineRun(acc: RichAccumulator, pmPos: number): void {
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

export function appendInlineRuns(
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

export const LIST_ITEM_NODE_NAMES = new Set(["taskItem", "listItem"]);

// Tiptap leaves indent and marker attributes unchanged when moving items; rebuilding would undo the move.
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

export function listItemPrefix(item: ProseMirrorNode, empty: boolean): string {
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

export function walkList(list: ProseMirrorNode, listStart: number, acc: RichAccumulator): void {
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

export function appendCodeBlockRun(
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

export function walkBlockquote(quote: ProseMirrorNode, quoteStart: number, acc: RichAccumulator): void {
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

// Docs are immutable, and one keystroke serializes the same doc from the marker
// plugin, onUpdate, and onSelectionUpdate.
export const serializedDocs = new WeakMap<ProseMirrorNode, RichDocMap>();

export function serializeEditorDoc(doc: ProseMirrorNode): RichDocMap {
  let map = serializedDocs.get(doc);
  if (!map) {
    map = serializeDoc(doc);
    serializedDocs.set(doc, map);
  }
  return map;
}

export function serializeDoc(doc: ProseMirrorNode): RichDocMap {
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
export function runOwnsOffset(run: RichRun, flatOffset: number): boolean {
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

export function styledEdge(state: EditorState) {
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

