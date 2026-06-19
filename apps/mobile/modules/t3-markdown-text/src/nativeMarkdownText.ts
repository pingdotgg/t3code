import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import type { SelectableMarkdownSkill } from "./SelectableMarkdownText.types";
import { resolveMarkdownLinkPresentation, type MarkdownFileIcon } from "./markdownLinks";

export interface NativeMarkdownTextRun {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
  readonly code?: boolean;
  readonly href?: string;
  readonly externalHost?: string;
  readonly fileIcon?: MarkdownFileIcon;
  readonly skillName?: string;
  readonly skillLabel?: string;
  readonly role?:
    | "body"
    | "heading"
    | "list-marker"
    | "list-break"
    | "quote-marker"
    | "code-block"
    | "code-language"
    | "divider"
    | "spacer";
  readonly headingLevel?: number;
  readonly depth?: number;
  readonly spacing?: number;
  readonly firstLineHeadIndent?: number;
  readonly headIndent?: number;
  readonly paragraphSpacing?: number;
}

export type NativeMarkdownDocumentChunk =
  | {
      readonly kind: "selectable";
      readonly key: string;
      readonly node: MarkdownNode;
    }
  | {
      readonly kind: "rich";
      readonly key: string;
      readonly node: MarkdownNode;
    };

interface RunContext {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strikethrough: boolean;
  readonly code: boolean;
  readonly href?: string;
  readonly externalHost?: string;
  readonly fileIcon?: MarkdownFileIcon;
  readonly role?: NativeMarkdownTextRun["role"];
  readonly headingLevel?: number;
  readonly depth?: number;
  readonly spacing?: number;
  readonly firstLineHeadIndent?: number;
  readonly headIndent?: number;
  readonly paragraphSpacing?: number;
}

const EMPTY_CONTEXT: RunContext = {
  bold: false,
  italic: false,
  strikethrough: false,
  code: false,
};

const INLINE_HTML_TAG_PATTERN = /<\/?(?:kbd|mark|sub|sup|u)(?:\s[^>]*)?>/gi;

function decodeHtmlEntitiesOnce(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) {
        return String.fromCodePoint(Number.parseInt(decimal, 10));
      }
      if (hexadecimal) {
        return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      }
      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&apos;":
          return "'";
        case "&gt;":
          return ">";
        case "&lt;":
          return "<";
        case "&nbsp;":
          return "\u00a0";
        case "&quot;":
          return '"';
        default:
          return entity;
      }
    },
  );
}

function decodeHtmlEntities(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decodeHtmlEntitiesOnce(decoded);
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  return decoded;
}

function textNodeContent(value: string): string {
  return decodeHtmlEntities(value).replace(INLINE_HTML_TAG_PATTERN, "");
}

function inlineHtmlText(value: string): string {
  if (/^<br\s*\/?>$/i.test(value.trim())) {
    return "\n";
  }
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ""));
}

function sameRunStyle(left: NativeMarkdownTextRun, right: NativeMarkdownTextRun): boolean {
  return (
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.strikethrough === right.strikethrough &&
    left.code === right.code &&
    left.href === right.href &&
    left.externalHost === right.externalHost &&
    left.fileIcon === right.fileIcon &&
    left.skillName === right.skillName &&
    left.skillLabel === right.skillLabel &&
    left.role === right.role &&
    left.headingLevel === right.headingLevel &&
    left.depth === right.depth &&
    left.spacing === right.spacing &&
    left.firstLineHeadIndent === right.firstLineHeadIndent &&
    left.headIndent === right.headIndent &&
    left.paragraphSpacing === right.paragraphSpacing
  );
}

function appendRun(
  runs: NativeMarkdownTextRun[],
  text: string,
  context: RunContext,
): NativeMarkdownTextRun[] {
  if (text.length === 0) {
    return runs;
  }

  const run: NativeMarkdownTextRun = {
    text,
    ...(context.bold ? { bold: true } : {}),
    ...(context.italic ? { italic: true } : {}),
    ...(context.strikethrough ? { strikethrough: true } : {}),
    ...(context.code ? { code: true } : {}),
    ...(context.href ? { href: context.href } : {}),
    ...(context.externalHost ? { externalHost: context.externalHost } : {}),
    ...(context.fileIcon ? { fileIcon: context.fileIcon } : {}),
    ...(context.role ? { role: context.role } : {}),
    ...(context.headingLevel ? { headingLevel: context.headingLevel } : {}),
    ...(context.depth ? { depth: context.depth } : {}),
    ...(context.spacing ? { spacing: context.spacing } : {}),
    ...(context.firstLineHeadIndent !== undefined
      ? { firstLineHeadIndent: context.firstLineHeadIndent }
      : {}),
    ...(context.headIndent !== undefined ? { headIndent: context.headIndent } : {}),
    ...(context.paragraphSpacing !== undefined
      ? { paragraphSpacing: context.paragraphSpacing }
      : {}),
  };
  const previous = runs.at(-1);
  if (previous && sameRunStyle(previous, run)) {
    runs[runs.length - 1] = { ...previous, text: previous.text + run.text };
    return runs;
  }

  runs.push(run);
  return runs;
}

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

function formatSkillLabel(skill: SelectableMarkdownSkill): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return skill.name
    .split(/[\s:_-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function decorateSkillRuns(
  runs: ReadonlyArray<NativeMarkdownTextRun>,
  skills: ReadonlyArray<SelectableMarkdownSkill>,
): ReadonlyArray<NativeMarkdownTextRun> {
  if (skills.length === 0) {
    return runs;
  }
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  const decorated: NativeMarkdownTextRun[] = [];

  for (const run of runs) {
    if (run.code || run.href || run.fileIcon || run.role === "code-block") {
      decorated.push(run);
      continue;
    }

    let cursor = 0;
    let matched = false;
    for (const match of run.text.matchAll(SKILL_TOKEN_REGEX)) {
      const prefix = match[1] ?? "";
      const name = match[2] ?? "";
      const skill = skillByName.get(name);
      if (!skill) {
        continue;
      }
      const start = (match.index ?? 0) + prefix.length;
      const end = start + name.length + 1;
      if (start > cursor) {
        decorated.push({ ...run, text: run.text.slice(cursor, start) });
      }
      decorated.push({
        ...run,
        text: run.text.slice(start, end),
        skillName: name,
        skillLabel: formatSkillLabel(skill),
      });
      cursor = end;
      matched = true;
    }
    if (!matched) {
      decorated.push(run);
    } else if (cursor < run.text.length) {
      decorated.push({ ...run, text: run.text.slice(cursor) });
    }
  }

  return decorated;
}

function appendChildren(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  context: RunContext,
): NativeMarkdownTextRun[] {
  for (const child of node.children ?? []) {
    appendNode(runs, child, context);
  }
  return runs;
}

function nodeTextContent(node: MarkdownNode): string {
  if (node.content !== undefined) {
    return node.content;
  }
  return (node.children ?? []).map(nodeTextContent).join("");
}

function appendNode(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  context: RunContext,
): NativeMarkdownTextRun[] {
  switch (node.type) {
    case "text":
    case "math_inline":
      return appendRun(runs, textNodeContent(nodeTextContent(node)), context);
    case "html_inline":
      return appendRun(runs, inlineHtmlText(nodeTextContent(node)), context);
    case "code_inline":
      return appendRun(runs, nodeTextContent(node), { ...context, code: true });
    case "soft_break":
      return appendRun(runs, " ", context);
    case "line_break":
      return appendRun(runs, "\n", context);
    case "bold":
      return appendChildren(runs, node, { ...context, bold: true });
    case "italic":
      return appendChildren(runs, node, { ...context, italic: true });
    case "strikethrough":
      return appendChildren(runs, node, { ...context, strikethrough: true });
    case "link": {
      const presentation = resolveMarkdownLinkPresentation(node.href ?? "");
      if (presentation.kind === "file") {
        return appendRun(runs, presentation.label, {
          ...context,
          href: presentation.href,
          fileIcon: presentation.icon,
        });
      }
      if (presentation.kind === "external") {
        return appendChildren(runs, node, {
          ...context,
          href: presentation.href,
          externalHost: presentation.host,
        });
      }
      return appendChildren(runs, node, {
        ...context,
        ...(presentation.href ? { href: presentation.href } : {}),
      });
    }
    case "image":
      return appendRun(runs, node.alt ?? node.title ?? "", context);
    default:
      return appendChildren(runs, node, context);
  }
}

export function nativeMarkdownTextRuns(node: MarkdownNode): ReadonlyArray<NativeMarkdownTextRun> {
  return appendChildren([], node, EMPTY_CONTEXT);
}

export function nativeMarkdownWithPreservedSoftBreaks(node: MarkdownNode): MarkdownNode {
  const children = node.children?.map(nativeMarkdownWithPreservedSoftBreaks);
  return {
    ...node,
    ...(node.type === "soft_break" ? { type: "line_break" as const } : {}),
    ...(children ? { children } : {}),
  };
}

function appendBlockTerminator(
  runs: NativeMarkdownTextRun[],
  context: RunContext,
): NativeMarkdownTextRun[] {
  return appendRun(runs, "\n", context);
}

function appendSpacer(runs: NativeMarkdownTextRun[], spacing: number): NativeMarkdownTextRun[] {
  return appendRun(runs, "\n", { ...EMPTY_CONTEXT, role: "spacer", spacing });
}

function appendInlineChildren(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  context: RunContext,
): NativeMarkdownTextRun[] {
  for (const child of node.children ?? []) {
    appendNode(runs, child, context);
  }
  return runs;
}

function isInlineNode(node: MarkdownNode): boolean {
  return (
    node.type === "text" ||
    node.type === "bold" ||
    node.type === "italic" ||
    node.type === "strikethrough" ||
    node.type === "link" ||
    node.type === "image" ||
    node.type === "code_inline" ||
    node.type === "math_inline" ||
    node.type === "html_inline" ||
    node.type === "soft_break" ||
    node.type === "line_break"
  );
}

export function nativeMarkdownListItemBlocks(node: MarkdownNode): ReadonlyArray<MarkdownNode> {
  const blocks: MarkdownNode[] = [];
  let inlineNodes: MarkdownNode[] = [];
  const flushInlineNodes = () => {
    if (inlineNodes.length === 0) {
      return;
    }
    blocks.push({ type: "paragraph", children: inlineNodes });
    inlineNodes = [];
  };

  for (const child of node.children ?? []) {
    if (isInlineNode(child)) {
      inlineNodes.push(child);
      continue;
    }

    flushInlineNodes();
    blocks.push(child);
  }
  flushInlineNodes();
  return blocks;
}

function appendListItem(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  marker: string,
  depth: number,
  markerColumnWidth: number,
): NativeMarkdownTextRun[] {
  const firstLineHeadIndent = Math.max(0, depth - 1) * 20;
  appendRun(runs, `${marker}\t`, {
    ...EMPTY_CONTEXT,
    role: "list-marker",
    depth,
    firstLineHeadIndent,
    headIndent: firstLineHeadIndent + markerColumnWidth,
    paragraphSpacing: 2,
  });

  const children = node.children ?? [];
  let wroteInlineContent = false;
  for (const child of children) {
    if (child.type === "paragraph") {
      appendInlineChildren(runs, child, {
        ...EMPTY_CONTEXT,
        role: "body",
        depth,
      });
      wroteInlineContent = true;
      continue;
    }
    if (child.type === "list") {
      if (wroteInlineContent) {
        appendBlockTerminator(runs, {
          ...EMPTY_CONTEXT,
          role: "list-break",
          depth,
          spacing: 1,
        });
      }
      appendList(runs, child, depth + 1);
      wroteInlineContent = false;
      continue;
    }
    if (isInlineNode(child)) {
      appendNode(runs, child, {
        ...EMPTY_CONTEXT,
        role: "body",
        depth,
      });
      wroteInlineContent = true;
      continue;
    }
    appendDocumentBlock(runs, child, depth);
    wroteInlineContent = true;
  }

  if (wroteInlineContent) {
    appendBlockTerminator(runs, {
      ...EMPTY_CONTEXT,
      role: "list-break",
      depth,
      spacing: depth === 1 ? 4 : 2,
    });
  }
  return runs;
}

function appendList(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  depth: number,
): NativeMarkdownTextRun[] {
  const ordered = node.ordered ?? false;
  const start = node.start ?? 1;
  const children = node.children ?? [];
  const markers = children.map((child, index) =>
    child.type === "task_list_item"
      ? child.checked
        ? "☑︎"
        : "☐︎"
      : ordered
        ? `${start + index}.`
        : depth % 3 === 2
          ? "◦"
          : depth % 3 === 0
            ? "▪︎"
            : "•",
  );
  const markerWidth = ordered
    ? Math.max(0, ...markers.map((marker) => Array.from(marker).length))
    : 0;

  for (const [index, child] of children.entries()) {
    const marker = markers[index] ?? "•";
    const alignedMarker =
      child.type === "task_list_item"
        ? marker
        : ordered
          ? `${"\u2007".repeat(Math.max(0, markerWidth - Array.from(marker).length))}${marker}`
          : marker;
    const markerColumnWidth =
      child.type === "task_list_item" ? 28 : ordered ? 10 + markerWidth * 8 : 24;
    appendListItem(runs, child, alignedMarker, depth, markerColumnWidth);
  }
  return runs;
}

function appendQuoteBlock(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  depth: number,
): NativeMarkdownTextRun[] {
  for (const [index, child] of (node.children ?? []).entries()) {
    if (index > 0) {
      appendBlockTerminator(runs, { ...EMPTY_CONTEXT, role: "body", depth });
    }
    appendRun(runs, "│\u00a0", {
      ...EMPTY_CONTEXT,
      role: "quote-marker",
      depth,
    });
    if (child.type === "paragraph") {
      appendInlineChildren(runs, child, {
        ...EMPTY_CONTEXT,
        role: "body",
        depth,
      });
    } else {
      appendDocumentBlock(runs, child, depth);
    }
  }
  appendBlockTerminator(runs, { ...EMPTY_CONTEXT, role: "body", depth });
  return runs;
}

function appendTableRow(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  depth: number,
): NativeMarkdownTextRun[] {
  const cells = node.children ?? [];
  for (const [index, cell] of cells.entries()) {
    if (index > 0) {
      appendRun(runs, "\u00a0│\u00a0", {
        ...EMPTY_CONTEXT,
        role: "divider",
        depth,
      });
    }
    appendInlineChildren(runs, cell, {
      ...EMPTY_CONTEXT,
      role: "body",
      bold: cell.isHeader ?? false,
      depth,
    });
  }
  appendBlockTerminator(runs, { ...EMPTY_CONTEXT, role: "body", depth });
  return runs;
}

function appendTable(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  depth: number,
): NativeMarkdownTextRun[] {
  const visit = (child: MarkdownNode) => {
    if (child.type === "table_row") {
      appendTableRow(runs, child, depth);
      return;
    }
    for (const nested of child.children ?? []) {
      visit(nested);
    }
  };
  visit(node);
  return runs;
}

function appendDocumentBlock(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  depth = 0,
): NativeMarkdownTextRun[] {
  switch (node.type) {
    case "document": {
      const children = node.children ?? [];
      for (const [index, child] of children.entries()) {
        if (index > 0) {
          const previous = children[index - 1];
          appendSpacer(
            runs,
            child.type === "heading" ? 20 : previous?.type === "heading" ? 10 : 12,
          );
        }
        appendDocumentBlock(runs, child, depth);
      }
      return runs;
    }
    case "heading": {
      const context: RunContext = {
        ...EMPTY_CONTEXT,
        role: "heading",
        headingLevel: node.level ?? 1,
        depth,
      };
      appendInlineChildren(runs, node, context);
      return appendBlockTerminator(runs, context);
    }
    case "paragraph": {
      const context: RunContext = { ...EMPTY_CONTEXT, role: "body", depth };
      appendInlineChildren(runs, node, context);
      return appendBlockTerminator(runs, context);
    }
    case "list":
      return appendList(runs, node, depth + 1);
    case "blockquote":
      return appendQuoteBlock(runs, node, depth);
    case "code_block": {
      if (node.language) {
        appendRun(runs, `${node.language.toUpperCase()}\n`, {
          ...EMPTY_CONTEXT,
          role: "code-language",
          code: true,
          depth,
        });
      }
      const content = nodeTextContent(node);
      appendRun(runs, content, {
        ...EMPTY_CONTEXT,
        role: "code-block",
        code: true,
        depth,
      });
      if (!content.endsWith("\n")) {
        appendBlockTerminator(runs, {
          ...EMPTY_CONTEXT,
          role: "code-block",
          code: true,
          depth,
        });
      }
      return runs;
    }
    case "horizontal_rule":
      appendRun(runs, "────────────────────────\n", {
        ...EMPTY_CONTEXT,
        role: "divider",
        depth,
      });
      return runs;
    case "table":
      return appendTable(runs, node, depth);
    case "html_block":
      appendRun(runs, inlineHtmlText(nodeTextContent(node)), {
        ...EMPTY_CONTEXT,
        role: "body",
        depth,
      });
      return appendBlockTerminator(runs, { ...EMPTY_CONTEXT, role: "body", depth });
    case "math_block":
      appendRun(runs, nodeTextContent(node), { ...EMPTY_CONTEXT, role: "body", depth });
      return appendBlockTerminator(runs, { ...EMPTY_CONTEXT, role: "body", depth });
    default:
      appendInlineChildren(runs, node, { ...EMPTY_CONTEXT, role: "body", depth });
      return appendBlockTerminator(runs, { ...EMPTY_CONTEXT, role: "body", depth });
  }
}

function containsRichBlock(node: MarkdownNode): boolean {
  if (
    node.type === "code_block" ||
    node.type === "table" ||
    node.type === "image" ||
    node.type === "horizontal_rule" ||
    node.type === "html_block" ||
    node.type === "math_block"
  ) {
    return true;
  }
  return (node.children ?? []).some(containsRichBlock);
}

export function nativeMarkdownDocumentChunks(
  document: MarkdownNode,
): ReadonlyArray<NativeMarkdownDocumentChunk> {
  const chunks: NativeMarkdownDocumentChunk[] = [];
  let selectableNodes: MarkdownNode[] = [];

  const flushSelectable = () => {
    if (selectableNodes.length === 0) {
      return;
    }
    const first = selectableNodes[0];
    const last = selectableNodes.at(-1);
    chunks.push({
      kind: "selectable",
      key: `selectable:${first?.beg ?? "start"}:${last?.end ?? "end"}`,
      node: {
        type: "document",
        children: selectableNodes,
      },
    });
    selectableNodes = [];
  };

  for (const [index, child] of (document.children ?? []).entries()) {
    if (!containsRichBlock(child)) {
      selectableNodes.push(child);
      continue;
    }

    flushSelectable();
    chunks.push({
      kind: "rich",
      key: `rich:${child.type}:${child.beg ?? index}:${child.end ?? index}`,
      node: child,
    });
  }
  flushSelectable();
  return chunks;
}

function topLevelNodes(node: MarkdownNode): ReadonlyArray<MarkdownNode> {
  return node.type === "document" ? (node.children ?? []) : [node];
}

export function nativeMarkdownChunkSpacing(
  previous: NativeMarkdownDocumentChunk | undefined,
  current: NativeMarkdownDocumentChunk,
): number {
  if (!previous) {
    return 0;
  }

  const previousLast = topLevelNodes(previous.node).at(-1);
  const currentFirst = topLevelNodes(current.node)[0];

  if (currentFirst?.type === "heading") {
    return 20;
  }
  if (previousLast?.type === "heading") {
    return 10;
  }
  if (previousLast?.type === "list" && currentFirst?.type === "list") {
    return 12;
  }
  return 14;
}

export function nativeMarkdownDocumentRuns(
  node: MarkdownNode,
  skills: ReadonlyArray<SelectableMarkdownSkill> = [],
): ReadonlyArray<NativeMarkdownTextRun> {
  const runs = appendDocumentBlock([], node);
  while (runs.length > 0) {
    const lastIndex = runs.length - 1;
    const last = runs[lastIndex];
    if (!last?.text.endsWith("\n")) {
      break;
    }
    const text = last.text.slice(0, -1);
    if (text.length === 0) {
      runs.pop();
    } else {
      runs[lastIndex] = { ...last, text };
    }
  }
  return decorateSkillRuns(runs, skills);
}
