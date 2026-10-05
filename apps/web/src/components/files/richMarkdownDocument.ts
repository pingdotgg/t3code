import type { JSONContent } from "@tiptap/core";
import type { Root, RootContent } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);
type MarkdownNode = {
  type: string;
  value?: string;
  depth?: number;
  url?: string;
  title?: string | null;
  alt?: string | null;
  lang?: string | null;
  meta?: string | null;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  align?: (string | null)[];
  children?: MarkdownNode[];
};
/** Restrict rich links and images to supported relative paths and safe URL schemes. */
const safeUrl = (url: string) =>
  !/^\s*(?:javascript|vbscript|data):/i.test(url) &&
  ![...url].some((character) => character.charCodeAt(0) < 32);
/** Create a rich text leaf with its inherited marks without changing the source text. */
const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({
  type: "text",
  text: value,
  ...(marks?.length ? { marks } : {}),
});

/** Convert supported Markdown nodes into editable blocks and reject syntax that cannot be preserved safely. */
function convert(node: MarkdownNode, marks: NonNullable<JSONContent["marks"]> = []): JSONContent[] {
  /** Convert child Markdown nodes while retaining the current inline formatting marks. */
  const children = () => (node.children ?? []).flatMap((child) => convert(child, marks));
  switch (node.type) {
    case "text":
      if (node.value && /\[\[[^\]]+\]\]|\$\$|\$[^$\n]+\$|\{\{[^}]+\}\}/.test(node.value))
        throw new Error(
          "Wiki links, math, and template syntax require Source mode so their meaning is preserved.",
        );
      return node.value ? [text(node.value, marks)] : [];
    case "inlineCode":
      return [text(node.value ?? "", [...marks, { type: "code" }])];
    case "strong":
    case "emphasis":
    case "delete":
      return (node.children ?? []).flatMap((child) =>
        convert(child, [
          ...marks,
          {
            type: node.type === "strong" ? "bold" : node.type === "emphasis" ? "italic" : "strike",
          },
        ]),
      );
    case "link":
      if (!safeUrl(node.url ?? ""))
        throw new Error("This document contains an unsafe link. Use Source to inspect it.");
      return (node.children ?? []).flatMap((child) =>
        convert(child, [
          ...marks,
          { type: "link", attrs: { href: node.url, title: node.title ?? null } },
        ]),
      );
    case "image":
      if (!safeUrl(node.url ?? "")) throw new Error("This image URL requires Source mode.");
      return [
        { type: "image", attrs: { src: node.url, alt: node.alt ?? "", title: node.title ?? null } },
      ];
    case "break":
      return [{ type: "hardBreak" }];
    case "paragraph":
      return [{ type: "paragraph", content: children() }];
    case "heading":
      return [{ type: "heading", attrs: { level: node.depth }, content: children() }];
    case "blockquote":
      return [{ type: "blockquote", content: children() }];
    case "thematicBreak":
      return [{ type: "horizontalRule" }];
    case "code":
      if (node.meta)
        throw new Error("Code fence metadata requires Source mode so it is preserved exactly.");
      return [
        {
          type: "codeBlock",
          attrs: { language: node.lang ?? null },
          content: node.value ? [text(node.value)] : [],
        },
      ];
    case "list": {
      const task = node.children?.some((child) => child.checked != null);
      if (task && node.ordered)
        throw new Error("Numbered task lists require Source mode to preserve their numbering.");
      if (task && node.children?.some((child) => child.checked == null))
        throw new Error("Mixed task and ordinary list items require Source mode.");
      return [
        {
          type: task ? "taskList" : node.ordered ? "orderedList" : "bulletList",
          attrs: node.ordered ? { start: node.start ?? 1 } : {},
          content: (node.children ?? []).map((child) => ({
            type: task ? "taskItem" : "listItem",
            attrs: task ? { checked: !!child.checked } : {},
            content: convertChildren(child),
          })),
        },
      ];
    }
    case "table":
      return [
        {
          type: "table",
          content: (node.children ?? []).map((row, rowIndex) => ({
            type: "tableRow",
            content: (row.children ?? []).map((cell, column) => ({
              type: rowIndex ? "tableCell" : "tableHeader",
              attrs: { align: node.align?.[column] ?? null },
              content: [{ type: "paragraph", content: convertChildren(cell) }],
            })),
          })),
        },
      ];
    default:
      throw new Error(`Markdown ${node.type} syntax requires Source mode to preserve it safely.`);
  }
}
/** Convert block children with fresh inline marks so formatting does not leak between blocks. */
function convertChildren(node: MarkdownNode) {
  return (node.children ?? []).flatMap((child) => convert(child));
}
/** Separate emphasis-boundary whitespace to match Markdown's representable formatting semantics. */
function formattingWhitespace(node: JSONContent): JSONContent[] {
  if (
    node.type !== "text" ||
    !node.text ||
    node.marks?.some((mark) => mark.type === "code") ||
    !node.marks?.some((mark) => ["bold", "italic", "strike"].includes(mark.type))
  )
    return [node];
  const leading = node.text.match(/^\s*/)?.[0] ?? "";
  const trailing = node.text.slice(leading.length).match(/\s*$/)?.[0] ?? "";
  const body = node.text.slice(leading.length, node.text.length - trailing.length);
  const marks = node.marks.filter((mark) => !["bold", "italic", "strike"].includes(mark.type));
  return [
    ...(leading ? [{ ...node, text: leading, marks }] : []),
    ...(body ? [{ ...node, text: body }] : []),
    ...(trailing ? [{ ...node, text: trailing, marks }] : []),
  ];
}
/** Ignore editor defaults and source IDs when deciding whether a block's authored content changed. */
function comparable(node: JSONContent): JSONContent {
  const { sourceId: _id, ...attrs } = node.attrs ?? {};
  // Tiptap fills default attributes and empty content; they are not source changes.
  const meaningful = Object.fromEntries(
    Object.entries(attrs).filter(
      ([key, value]) =>
        value != null &&
        value !== false &&
        !["colspan", "rowspan", "colwidth", "target", "rel", "class"].includes(key),
    ),
  );
  const content: JSONContent[] = [];
  for (const child of (node.content ?? []).flatMap(formattingWhitespace)) {
    const next = comparable(child);
    const previous = content.at(-1);
    if (
      next.type === "text" &&
      previous?.type === "text" &&
      JSON.stringify(next.marks) === JSON.stringify(previous.marks)
    )
      previous.text = (previous.text ?? "") + (next.text ?? "");
    else content.push(next);
  }
  return {
    ...(node.type ? { type: node.type } : {}),
    ...(node.text ? { text: node.text } : {}),
    ...(Object.keys(meaningful).length ? { attrs: meaningful } : {}),
    ...(node.marks?.length
      ? {
          marks: node.marks
            .map((mark) => {
              const normalized = comparable(mark);
              return { type: mark.type, ...(normalized.attrs ? { attrs: normalized.attrs } : {}) };
            })
            .sort((a, b) => a.type.localeCompare(b.type)),
        }
      : {}),
    ...(content.length ? { content } : {}),
  };
}
/** Escape literal inline Markdown punctuation when serializing newly edited text. */
const escapeText = (value: string) =>
  value.replace(/([\\`*_{}[\]<>~|])/g, "\\$1").replace(/^(#{1,6}|[-+]|\d+[.)]) /gm, "\\$1 ");
/** Serialize supported inline marks while preserving code and table-specific escaping. */
function inline(node: JSONContent, inTable = false): string {
  if (node.type === "hardBreak") return "  \n";
  if (node.type === "image")
    return `![${escapeText(node.attrs?.alt ?? "")}](${destination(node.attrs?.src ?? "")}${node.attrs?.title ? ` "${String(node.attrs.title).replaceAll('"', '\\"')}"` : ""})`;
  let value = escapeText(node.text ?? "");
  for (const mark of (node.marks ?? []).toReversed()) {
    if (mark.type === "code") {
      const fence = "`".repeat(
        Math.max(1, ...((node.text ?? "").match(/`+/g) ?? []).map((s) => s.length + 1)),
      );
      value = `${fence} ${inTable ? (node.text ?? "").replaceAll("|", "\\|") : (node.text ?? "")} ${fence}`;
    } else if (["bold", "italic", "strike"].includes(mark.type)) {
      const marker = mark.type === "bold" ? "**" : mark.type === "italic" ? "*" : "~~";
      value = value.replace(/^(\s*)(.*?)(\s*)$/s, (_match, leading, body, trailing) =>
        body ? `${leading}${marker}${body}${marker}${trailing}` : value,
      );
    } else if (mark.type === "link")
      value = `[${value}](${destination(mark.attrs?.href ?? "")}${mark.attrs?.title ? ` "${String(mark.attrs.title).replaceAll('"', '\\"')}"` : ""})`;
    else throw new Error(`Use Source mode for ${mark.type} formatting.`);
  }
  return value;
}
/** Escape Markdown link destinations without changing their relative or absolute target. */
function destination(value: string) {
  if (!safeUrl(value)) throw new Error("Unsafe link URL.");
  return `<${value.replaceAll(">", "%3E").replaceAll("<", "%3C")}>`;
}
/** Serialize an edited block to supported Markdown and reject structures without a safe representation. */
function serialize(node: JSONContent, inTable = false): string {
  const content = node.content ?? [];
  /** Serialize nested blocks with paragraph separators and the enclosing table context. */
  const children = () => content.map((child) => serialize(child, inTable)).join("\n\n");
  /** Serialize inline children without separators, applying table escaping when needed. */
  const inlines = () => content.map((child) => inline(child, inTable)).join("");
  switch (node.type) {
    case "paragraph":
      return inlines();
    case "heading":
      return `${"#".repeat(node.attrs?.level ?? 1)} ${inlines()}`;
    case "blockquote":
      return children()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "horizontalRule":
      return "---";
    case "codeBlock": {
      const value = content.map((n) => n.text ?? "").join("");
      const fence = "`".repeat(Math.max(3, ...(value.match(/`+/g) ?? []).map((s) => s.length + 1)));
      return `${fence}${node.attrs?.language ?? ""}\n${value}\n${fence}`;
    }
    case "bulletList":
    case "orderedList":
    case "taskList":
      return content
        .map((item, i) => {
          const prefix =
            node.type === "orderedList"
              ? `${(node.attrs?.start ?? 1) + i}. `
              : node.type === "taskList"
                ? `- [${item.attrs?.checked ? "x" : " "}] `
                : "- ";
          return (item.content ?? [])
            .map((child) => serialize(child, inTable))
            .join("\n\n")
            .split("\n")
            .map((line, j) => (j ? " ".repeat(prefix.length) : prefix) + line)
            .join("\n");
        })
        .join("\n");
    case "table": {
      const rows = content.map(
        (row) =>
          `| ${(row.content ?? [])
            .map((cell) =>
              (cell.content ?? [])
                .map((child) => serialize(child, true))
                .join(" ")
                .replaceAll("\n", " "),
            )
            .join(" | ")} |`,
      );
      rows.splice(
        1,
        0,
        `| ${(content[0]?.content ?? []).map((cell) => (cell.attrs?.align === "center" ? ":---:" : cell.attrs?.align === "right" ? "---:" : cell.attrs?.align === "left" ? ":---" : "---")).join(" | ")} |`,
      );
      return rows.join("\n");
    }
    default:
      throw new Error(`Use Source mode for ${node.type}.`);
  }
}
export interface RichMarkdownDocument {
  source: string;
  prefix: string;
  blocks: {
    id: string;
    raw: string;
    separator: string;
    json: JSONContent;
    startLine: number;
    endLine: number;
  }[];
  content: JSONContent;
}
/** Capture original blocks, separators, and front matter, or return a reason to keep the file in Source mode. */
export function parseRichMarkdown(source: string): RichMarkdownDocument | { reason: string } {
  if (source.length > 300_000)
    return { reason: "Documents over 300 KB use Source mode for responsiveness." };
  const frontMatter =
    source.match(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/)?.[0] ?? "";
  const body = source.slice(frontMatter.length);
  try {
    const root = parser.parse(body) as Root;
    const prefix =
      frontMatter + body.slice(0, root.children[0]?.position?.start.offset ?? body.length);
    const blocks = root.children.map((node: RootContent, index) => {
      const start = node.position!.start.offset!;
      const end = node.position!.end.offset!;
      const json = convert(node as MarkdownNode)[0]!;
      const id = `block-${index}`;
      json.attrs = { ...json.attrs, sourceId: id };
      return {
        id,
        json,
        raw: body.slice(start, end),
        separator: body.slice(end, root.children[index + 1]?.position?.start.offset ?? body.length),
        startLine: node.position!.start.line + frontMatter.split("\n").length - 1,
        endLine: node.position!.end.line + frontMatter.split("\n").length - 1,
      };
    });
    return {
      source,
      prefix,
      blocks,
      content: {
        type: "doc",
        content: blocks.length ? blocks.map((b) => b.json) : [{ type: "paragraph" }],
      },
    };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : "This Markdown requires Source mode.",
    };
  }
}
/** Reuse unchanged raw blocks and verify that each changed block parses back into the same structure. */
function serializeBlocks(document: RichMarkdownDocument, json: JSONContent) {
  const seen = new Set<string>();
  const originals = new Map(document.blocks.map((block) => [block.id, block]));
  const nodes = json.content ?? [];
  return nodes.map((node, index) => {
    const original = seen.has(node.attrs?.sourceId)
      ? undefined
      : originals.get(node.attrs?.sourceId);
    if (original) seen.add(original.id);
    const unchanged =
      original && JSON.stringify(comparable(node)) === JSON.stringify(comparable(original.json));
    const value = unchanged ? original.raw : serialize(node);
    // A changed block must parse back into the same structure. Keep the source
    // untouched if Markdown cannot express the edit (for example merged cells).
    if (!unchanged && value.trim()) {
      const reparsed = parser.parse(value) as Root;
      const converted = reparsed.children.flatMap((child) => convert(child as MarkdownNode));
      if (
        converted.length !== 1 ||
        JSON.stringify(comparable(converted[0]!)) !== JSON.stringify(comparable(node))
      ) {
        throw new Error("This edit cannot be represented safely in Markdown. Use Source mode.");
      }
    }
    const separator =
      index < nodes.length - 1
        ? original?.separator || "\n\n"
        : (original?.separator ?? (document.source.endsWith("\n") ? "\n" : ""));
    return { value, separator };
  });
}
/** Return untouched source verbatim and rewrite only changed blocks after round-trip validation. */
export function serializeRichMarkdown(document: RichMarkdownDocument, json: JSONContent): string {
  if (JSON.stringify(comparable(json)) === JSON.stringify(comparable(document.content)))
    return document.source;
  return (
    document.prefix +
    serializeBlocks(document, json)
      .map((block) => block.value + block.separator)
      .join("")
  );
}
/** Track the serialized editor blocks, including empty paragraphs that Markdown parsing omits. */
export function richSelectionSourceLines(
  document: RichMarkdownDocument,
  json: JSONContent,
  first: number,
  last: number,
  currentSource: string,
) {
  if (serializeRichMarkdown(document, json) !== currentSource) return null;
  const blocks = serializeBlocks(document, json);
  if (first < 0 || last < first || last >= blocks.length) return null;
  let line = document.prefix.split("\n").length;
  let startLine: number | null = null;
  let endLine: number | null = null;
  for (const [index, block] of blocks.entries()) {
    if (index >= first && index <= last && block.value.trim()) {
      startLine ??= line;
      endLine = line + block.value.split("\n").length - 1;
    }
    line += (block.value + block.separator).split("\n").length - 1;
  }
  return startLine === null || endLine === null ? null : { startLine, endLine };
}
/** Resolve an original block only while its captured document still matches the current source. */
export function selectedMarkdownLines(
  document: RichMarkdownDocument,
  sourceId: string,
  currentSource: string,
) {
  // Mapping is deliberately conservative: an agent edit invalidates the captured range.
  if (document.source !== currentSource) return null;
  const block = document.blocks.find((b) => b.id === sourceId);
  return block ? { startLine: block.startLine, endLine: block.endLine } : null;
}
