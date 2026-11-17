/**
 * Jira Cloud's rich text (Atlassian Document Format) to and from the markdown every client edits.
 * Reading keeps what markdown can say and names the rest; writing produces only nodes Jira's
 * schema accepts where markdown put them, since Jira refuses a whole document over one bad node.
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface AdfNode {
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: ReadonlyArray<{
    readonly type: string;
    readonly attrs?: Readonly<Record<string, unknown>>;
  }>;
  readonly content?: ReadonlyArray<AdfNode>;
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null && typeof (value as AdfNode).type === "string";
}

const children = (node: AdfNode): ReadonlyArray<AdfNode> =>
  Array.isArray(node.content) ? node.content.filter(isNode) : [];

const attr = (node: AdfNode, key: string): string | null => {
  const value = node.attrs?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

function inline(node: AdfNode): string {
  switch (node.type) {
    case "text": {
      let text = node.text ?? "";
      const marks = node.marks ?? [];
      if (marks.some((mark) => mark.type === "code")) text = `\`${text}\``;
      for (const mark of marks) {
        if (mark.type === "strong") text = `**${text}**`;
        else if (mark.type === "em") text = `*${text}*`;
        else if (mark.type === "strike") text = `~~${text}~~`;
      }
      const href = marks.find((mark) => mark.type === "link")?.attrs?.["href"];
      return typeof href === "string" ? `[${text}](${href})` : text;
    }
    case "hardBreak":
      return "\n";
    case "mention":
      return attr(node, "text") ?? "@someone";
    case "emoji":
      return attr(node, "text") ?? attr(node, "shortName") ?? "";
    case "inlineCard":
      return attr(node, "url") ?? "";
    case "status":
      return `[${attr(node, "text") ?? "status"}]`;
    case "date": {
      const at = Number(node.attrs?.["timestamp"]);
      return Option.match(DateTime.make(at), {
        onNone: () => "",
        onSome: (date) => DateTime.formatIso(date).slice(0, 10),
      });
    }
    case "mediaInline":
      return "_(attachment)_";
    default:
      return children(node).map(inline).join("");
  }
}

const inlines = (node: AdfNode) => children(node).map(inline).join("");

const indent = (text: string, prefix: string) =>
  text
    .split("\n")
    .map((line) => (line.length === 0 ? prefix.trimEnd() : prefix + line))
    .join("\n");

function list(node: AdfNode, marker: (index: number) => string): string {
  return children(node)
    .map((item, index) => {
      const lead = marker(index);
      const body = blocks(children(item), "\n");
      return lead + indent(body, " ".repeat(lead.length)).slice(lead.length);
    })
    .join("\n");
}

function table(node: AdfNode): string {
  const rows = children(node).map((row) =>
    children(row).map((cell) =>
      blocks(children(cell), " ").replaceAll("\n", " ").replaceAll("|", "\\|"),
    ),
  );
  const [head, ...rest] = rows;
  if (head === undefined) return "";
  const line = (cells: ReadonlyArray<string>) => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rest.map(line)].join("\n");
}

function block(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return inlines(node);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.["level"]) || 1));
      return `${"#".repeat(level)} ${inlines(node)}`;
    }
    case "bulletList":
      return list(node, () => "- ");
    case "orderedList": {
      const start = Number(node.attrs?.["order"]) || 1;
      return list(node, (index) => `${start + index}. `);
    }
    case "taskList":
      return children(node)
        .map((item) => `- [${item.attrs?.["state"] === "DONE" ? "x" : " "}] ${inlines(item)}`)
        .join("\n");
    case "codeBlock":
      return `\`\`\`${attr(node, "language") ?? ""}\n${children(node)
        .map((child) => child.text ?? "")
        .join("")}\n\`\`\``;
    case "blockquote":
    case "panel":
      return indent(blocks(children(node)), "> ");
    case "rule":
      return "---";
    case "expand":
    case "nestedExpand": {
      const title = attr(node, "title");
      return [...(title === null ? [] : [`**${title}**`]), blocks(children(node))].join("\n\n");
    }
    case "table":
      return table(node);
    case "mediaSingle":
    case "mediaGroup":
      return "_(attachment)_";
    case "blockCard":
    case "embedCard":
      return attr(node, "url") ?? "";
    default:
      return node.content === undefined ? inline(node) : blocks(children(node));
  }
}

const blocks = (nodes: ReadonlyArray<AdfNode>, separator = "\n\n") =>
  nodes
    .map(block)
    .filter((text) => text.length > 0)
    .join(separator);

/** Markdown for a description or comment body; empty for none. Jira sends null for no text. */
export function adfToMarkdown(document: unknown): string {
  if (typeof document === "string") return document;
  return isNode(document) ? blocks(children(document)) : "";
}

/** What `markdownToAdf` cannot write back, so rewriting the text would drop it from Jira. */
const UNWRITABLE = new Set([
  "media",
  "mediaSingle",
  "mediaGroup",
  "mediaInline",
  "extension",
  "bodiedExtension",
  "inlineExtension",
  "layoutSection",
  "decisionList",
  "mention",
  "status",
  "date",
  "expand",
  "nestedExpand",
  "panel",
  "blockCard",
  "embedCard",
]);

export function hasUnwritableContent(document: unknown): boolean {
  if (!isNode(document)) return false;
  return UNWRITABLE.has(document.type) || children(document).some(hasUnwritableContent);
}

interface Mdast {
  readonly type: string;
  readonly value?: string;
  readonly depth?: number;
  readonly ordered?: boolean | null;
  readonly start?: number | null;
  readonly checked?: boolean | null;
  readonly lang?: string | null;
  readonly url?: string;
  readonly alt?: string | null;
  readonly children?: ReadonlyArray<Mdast>;
}

type Mark = NonNullable<AdfNode["marks"]>[number];

const text = (value: string, marks: ReadonlyArray<Mark>): AdfNode[] =>
  value.length === 0
    ? []
    : [{ type: "text", text: value, ...(marks.length === 0 ? {} : { marks }) }];

function toInline(node: Mdast, marks: ReadonlyArray<Mark>): AdfNode[] {
  const within = (mark: Mark) =>
    (node.children ?? []).flatMap((child) => toInline(child, [...marks, mark]));
  switch (node.type) {
    case "text":
    case "html":
      return text(node.value ?? "", marks);
    case "inlineCode":
      // Jira allows a code mark beside a link and nothing else.
      return text(node.value ?? "", [
        ...marks.filter((mark) => mark.type === "link"),
        { type: "code" },
      ]);
    case "strong":
      return within({ type: "strong" });
    case "emphasis":
      return within({ type: "em" });
    case "delete":
      return within({ type: "strike" });
    case "link":
      return within({ type: "link", attrs: { href: node.url ?? "" } });
    case "image":
      return text(node.alt || node.url || "", [
        ...marks,
        { type: "link", attrs: { href: node.url ?? "" } },
      ]);
    case "break":
      return [{ type: "hardBreak" }];
    default:
      return (node.children ?? []).flatMap((child) => toInline(child, marks));
  }
}

const paragraph = (node: Mdast, lead = ""): AdfNode => ({
  type: "paragraph",
  content: [...text(lead, []), ...(node.children ?? []).flatMap((child) => toInline(child, []))],
});

/** `nested` is inside a list item or quote, where Jira takes only text, lists and code. */
function toBlocks(node: Mdast, nested: boolean): AdfNode[] {
  switch (node.type) {
    case "paragraph":
      return [paragraph(node)];
    case "heading":
      return nested
        ? [paragraph(node)]
        : [{ ...paragraph(node), type: "heading", attrs: { level: node.depth ?? 1 } }];
    case "code":
      return [
        {
          type: "codeBlock",
          ...(node.lang ? { attrs: { language: node.lang } } : {}),
          content: text(node.value ?? "", []),
        },
      ];
    case "thematicBreak":
      return nested ? [] : [{ type: "rule" }];
    case "blockquote": {
      const content = (node.children ?? []).flatMap((child) => toBlocks(child, true));
      return nested ? content : [{ type: "blockquote", content }];
    }
    case "list":
      return [
        {
          type: node.ordered ? "orderedList" : "bulletList",
          ...(node.ordered && node.start != null ? { attrs: { order: node.start } } : {}),
          content: (node.children ?? []).map((item) => {
            // A task's box stays as text: Jira's task nodes hold no nested content.
            const lead = item.checked == null ? "" : item.checked ? "[x] " : "[ ] ";
            const [first, ...rest] = item.children ?? [];
            const body =
              first?.type === "paragraph"
                ? [paragraph(first, lead), ...rest.flatMap((child) => toBlocks(child, true))]
                : [
                    { type: "paragraph", content: text(lead, []) },
                    ...(item.children ?? []).flatMap((child) => toBlocks(child, true)),
                  ];
            return { type: "listItem", content: body };
          }),
        },
      ];
    case "table": {
      const rows = (node.children ?? []).map((row, index) => ({
        type: "tableRow",
        content: (row.children ?? []).map((cell) => ({
          type: index === 0 ? "tableHeader" : "tableCell",
          content: [paragraph(cell)],
        })),
      }));
      return nested
        ? rows.flatMap((row) => row.content.flatMap((cell) => cell.content))
        : [{ type: "table", content: rows }];
    }
    case "html":
      return [{ type: "paragraph", content: text(node.value ?? "", []) }];
    default:
      return (node.children ?? []).flatMap((child) => toBlocks(child, nested));
  }
}

const parser = unified().use(remarkParse).use(remarkGfm);

export function markdownToAdf(markdown: string): AdfNode & { readonly version: 1 } {
  const root = parser.parse(markdown) as Mdast;
  return {
    version: 1,
    type: "doc",
    content: (root.children ?? []).flatMap((child) => toBlocks(child, false)),
  };
}
