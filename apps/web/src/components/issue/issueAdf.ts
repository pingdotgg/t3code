import {
  Schema,
  type DOMOutputSpec,
  type MarkSpec,
  type Node as EditorNode,
  type NodeSpec,
  Fragment,
  Slice,
} from "@tiptap/pm/model";
import type { IssueRichBody } from "@t3tools/contracts";

type NativeValue =
  | null
  | boolean
  | number
  | string
  | NativeValue[]
  | { [key: string]: NativeValue };
export type AdfNode = {
  type: string;
  text?: string;
  content?: AdfNode[];
  marks?: AdfNode[];
  attrs?: { [key: string]: NativeValue };
  [key: string]: NativeValue | AdfNode[] | undefined;
};

const nativeAttrs = { native: { default: null } };
const block = (content: string, tag: string): NodeSpec => ({
  group: "block",
  content,
  attrs: nativeAttrs,
  toDOM: () => [tag, 0],
});
const mark = (tag: string): MarkSpec => ({ attrs: nativeAttrs, toDOM: () => [tag, 0] });

export function safeIssueExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function preservedLabel(node: AdfNode | null) {
  if (node?.type === "mention") return "Preserved mention";
  if (node?.type === "media" || node?.type === "mediaSingle" || node?.type === "mediaGroup")
    return "Preserved media";
  if (node?.type === "table") return "Preserved table";
  if (node?.type === "emoji") return "Preserved emoji";
  return "Preserved native content";
}

const preserved = (inline: boolean): NodeSpec => ({
  inline,
  group: inline ? "inline" : "block",
  atom: true,
  selectable: true,
  attrs: nativeAttrs,
  toDOM: (node): DOMOutputSpec => [
    inline ? "span" : "div",
    {
      contenteditable: "false",
      class: "rounded border border-border px-2 py-1 text-xs text-muted-foreground",
      "aria-label": preservedLabel(node.attrs.native),
    },
    preservedLabel(node.attrs.native),
  ],
});

export const issueAdfSchema = new Schema({
  nodes: {
    doc: { content: "block+", attrs: nativeAttrs },
    paragraph: block("inline*", "p"),
    heading: {
      ...block("inline*", "h2"),
      attrs: { ...nativeAttrs, level: { default: 2 } },
      toDOM: (node) => ["h" + Math.max(1, Math.min(6, node.attrs.level)), 0],
    },
    blockquote: block("block+", "blockquote"),
    bulletList: block("listItem+", "ul"),
    orderedList: {
      ...block("listItem+", "ol"),
      attrs: { ...nativeAttrs, order: { default: 1 } },
      toDOM: (node) => ["ol", { start: node.attrs.order }, 0],
    },
    listItem: { content: "paragraph block*", attrs: nativeAttrs, toDOM: () => ["li", 0] },
    codeBlock: {
      ...block("text*", "pre"),
      code: true,
      marks: "nativeText",
      whitespace: "pre",
      toDOM: () => ["pre", ["code", 0]],
    },
    rule: { group: "block", attrs: nativeAttrs, toDOM: () => ["hr"] },
    hardBreak: { inline: true, group: "inline", attrs: nativeAttrs, toDOM: () => ["br"] },
    text: { group: "inline" },
    preservedBlock: preserved(false),
    preservedInline: preserved(true),
  },
  marks: {
    nativeText: { attrs: nativeAttrs, inclusive: false, toDOM: () => ["span", 0] },
    strong: { ...mark("strong"), excludes: "strong code" },
    em: { ...mark("em"), excludes: "em code" },
    strike: { ...mark("s"), excludes: "strike code" },
    underline: { ...mark("u"), excludes: "underline code" },
    code: { ...mark("code"), excludes: "code strong em strike underline preservedMarks" },
    link: {
      attrs: { ...nativeAttrs, href: { default: "" } },
      inclusive: false,
      toDOM: (node) => {
        const href = safeIssueExternalUrl(node.attrs.href);
        return href === null
          ? ["span", 0]
          : ["a", { href, target: "_blank", rel: "noopener noreferrer" }, 0];
      },
    },
    preservedMarks: { attrs: nativeAttrs, toDOM: () => ["span", 0] },
  },
});

function isNode(value: unknown, depth = 0): value is AdfNode {
  if (depth > 100 || value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const node = value as AdfNode;
  return (
    typeof node.type === "string" &&
    (node.text === undefined || typeof node.text === "string") &&
    (node.content === undefined ||
      (Array.isArray(node.content) && node.content.every((child) => isNode(child, depth + 1)))) &&
    (node.marks === undefined ||
      (Array.isArray(node.marks) && node.marks.every((child) => isNode(child, depth + 1))))
  );
}

function encode(node: AdfNode, inline = false): EditorNode {
  if (node.type === "text" && node.text) {
    const marks = [issueAdfSchema.marks.nativeText!.create({ native: node })];
    const unknown: AdfNode[] = [];
    const seen = new Set<string>();
    for (const value of node.marks ?? []) {
      const type = issueAdfSchema.marks[value.type];
      if (
        !type ||
        value.type === "nativeText" ||
        value.type === "preservedMarks" ||
        seen.has(value.type)
      )
        unknown.push(value);
      else {
        marks.push(
          type.create({
            native: value,
            ...(value.type === "link" ? { href: value.attrs?.href ?? "" } : {}),
          }),
        );
        seen.add(value.type);
      }
    }
    if (unknown.length)
      marks.push(issueAdfSchema.marks.preservedMarks!.create({ native: unknown }));
    return issueAdfSchema.text(node.text, marks);
  }
  const type = issueAdfSchema.nodes[node.type];
  if (type && !["text", "preservedBlock", "preservedInline"].includes(node.type)) {
    try {
      return type.createChecked(
        {
          native: node,
          ...(node.type === "heading" ? { level: node.attrs?.level ?? 2 } : {}),
          ...(node.type === "orderedList" ? { order: node.attrs?.order ?? 1 } : {}),
        },
        node.content?.map((child) =>
          encode(child, node.type === "paragraph" || node.type === "heading"),
        ),
      );
    } catch {}
  }
  return issueAdfSchema.nodes[inline ? "preservedInline" : "preservedBlock"]!.create({
    native: node,
  });
}

function decode(node: EditorNode): AdfNode {
  const original = node.attrs.native as AdfNode | null;
  if (node.type.name === "preservedBlock" || node.type.name === "preservedInline") return original!;
  if (original && encode(original, node.isInline).eq(node)) return original;
  if (node.isText) {
    const source = node.marks.find((value) => value.type.name === "nativeText")?.attrs.native as
      | AdfNode
      | undefined;
    if (source && encode(source, true).eq(node)) return source;
    const marks = node.marks.flatMap((value): AdfNode[] => {
      if (value.type.name === "nativeText") return [];
      if (value.type.name === "preservedMarks") return value.attrs.native;
      const native = (value.attrs.native as AdfNode | null) ?? { type: value.type.name };
      return [
        value.type.name === "link"
          ? { ...native, attrs: { ...native.attrs, href: value.attrs.href } }
          : native,
      ];
    });
    const order = source?.marks ?? [];
    marks.sort(
      (a, b) =>
        order.findIndex((value) => value.type === a.type) -
        order.findIndex((value) => value.type === b.type),
    );
    const result: AdfNode = { ...source, type: "text", text: node.text! };
    if (marks.length || source?.marks !== undefined) result.marks = marks;
    else delete result.marks;
    return result;
  }
  const content: AdfNode[] = [];
  node.forEach((child) => content.push(decode(child)));
  const result: AdfNode = { ...original, type: node.type.name };
  if (original?.type !== node.type.name && result.attrs) {
    result.attrs = { ...result.attrs };
    if (original?.type === "heading") delete result.attrs.level;
    if (original?.type === "codeBlock") delete result.attrs.language;
  }
  if (content.length || original?.content !== undefined) result.content = content;
  if (node.type.name === "heading") result.attrs = { ...result.attrs, level: node.attrs.level };
  if (node.type.name === "orderedList" && node.attrs.order !== (original?.attrs?.order ?? 1))
    result.attrs = { ...result.attrs, order: node.attrs.order };
  return result;
}

export function readIssueAdf(body: IssueRichBody | undefined) {
  if (body?.format !== "adf" || body.document.length > 262_144) return null;
  try {
    const original: unknown = JSON.parse(body.document);
    if (!isNode(original) || original.type !== "doc" || original.version !== 1) return null;
    const doc = original.content?.length
      ? encode(original)
      : issueAdfSchema.nodes.doc!.create(
          { native: original },
          issueAdfSchema.nodes.paragraph!.create(),
        );
    if (doc.type.name !== "doc") return null;
    return {
      doc,
      serialize: (next: EditorNode): IssueRichBody => ({
        format: "adf",
        document: JSON.stringify(next.eq(doc) ? original : decode(next)),
      }),
    };
  } catch {
    return null;
  }
}

export function issueAdfClipboard(slice: Slice) {
  const content: { inline: boolean; node: AdfNode }[] = [];
  slice.content.forEach((node) => content.push({ inline: node.isInline, node: decode(node) }));
  return JSON.stringify({ content, openStart: slice.openStart, openEnd: slice.openEnd });
}

export function readIssueAdfClipboard(value: string) {
  if (value.length > 262_144) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object") return null;
    const { content, openStart, openEnd } = parsed as {
      content: { inline: boolean; node: unknown }[];
      openStart: number;
      openEnd: number;
    };
    if (
      !Array.isArray(content) ||
      !Number.isInteger(openStart) ||
      !Number.isInteger(openEnd) ||
      openStart < 0 ||
      openEnd < 0
    )
      return null;
    const nodes: EditorNode[] = [];
    for (const item of content) {
      if (typeof item.inline !== "boolean" || !isNode(item.node)) return null;
      nodes.push(encode(item.node, item.inline));
    }
    const fragment = Fragment.fromArray(nodes);
    const max = Slice.maxOpen(fragment);
    return openStart <= max.openStart && openEnd <= max.openEnd
      ? new Slice(fragment, openStart, openEnd)
      : null;
  } catch {
    return null;
  }
}

export function issueRichSourceLabel(body: IssueRichBody | undefined) {
  if (body?.format === "jira-wiki") return "Jira wiki markup";
  if (body?.format === "azure-html") return "HTML source";
  return null;
}

export function isEditableIssueRichBody(body: IssueRichBody | undefined) {
  return issueRichSourceLabel(body) !== null
    ? body!.document.length <= 65_536
    : readIssueAdf(body) !== null;
}
