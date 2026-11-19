/**
 * Jira Cloud keeps descriptions and comments as Atlassian Document Format; T3 Code reads and
 * writes Markdown. A read keeps the text and structure Markdown can carry and names what it
 * cannot (an attachment, an unknown macro) instead of dropping it silently.
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type * as Mdast from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface AdfMark {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
}

export interface AdfNode {
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Record<string, unknown>;
  readonly marks?: ReadonlyArray<AdfMark>;
  readonly content?: ReadonlyArray<AdfNode>;
}

const isNode = (value: unknown): value is AdfNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

const attr = (node: AdfNode, name: string): string | null => {
  const value = node.attrs?.[name];
  return typeof value === "string" && value !== "" ? value : null;
};

function inline(nodes: ReadonlyArray<AdfNode> | undefined): string {
  return (nodes ?? []).map(inlineNode).join("");
}

/** Literal Jira text, escaped so Markdown reads it back as the same characters. */
const escape = (text: string) =>
  text
    .replace(/[\\`*_~[\]<&]/g, "\\$&")
    .replace(/^(\s*)([#>+=-])/gm, "$1\\$2")
    .replace(/^(\s*\d+)([.)])/gm, "$1\\$2");

/** The shortest run of backticks that `text` does not contain, at least `min` long. */
const fence = (text: string, min: number) =>
  "`".repeat(Math.max(min, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length + 1)));

function marked(text: string, marks: ReadonlyArray<AdfMark> | undefined): string {
  const code = marks?.some((mark) => mark.type === "code") ?? false;
  let out = code ? text : escape(text);
  if (code) {
    const ticks = fence(text, 1);
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
    out = `${ticks}${pad}${out}${pad}${ticks}`;
  }
  for (const mark of marks ?? []) {
    if (mark.type === "strong") out = `**${out}**`;
    else if (mark.type === "em") out = `*${out}*`;
    else if (mark.type === "strike") out = `~~${out}~~`;
  }
  const link = marks?.find((mark) => mark.type === "link")?.attrs?.["href"];
  return typeof link === "string" ? `[${out}](${link})` : out;
}

function inlineNode(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return marked(node.text ?? "", node.marks);
    case "hardBreak":
      return "\n";
    case "mention":
      return attr(node, "text") ?? "@someone";
    case "emoji":
      return attr(node, "text") ?? attr(node, "shortName") ?? "";
    case "inlineCard":
    case "blockCard":
      return attr(node, "url") ?? "";
    case "status":
      return attr(node, "text") ?? "";
    case "date": {
      const timestamp = Number(attr(node, "timestamp"));
      return Option.match(DateTime.make(timestamp), {
        onNone: () => "",
        onSome: (date) => DateTime.formatIsoDateUtc(date),
      });
    }
    default:
      return inline(node.content);
  }
}

const indent = (text: string, prefix: string) =>
  text
    .split("\n")
    .map((line, index) => (index === 0 ? line : line === "" ? line : prefix + line))
    .join("\n");

function blocks(nodes: ReadonlyArray<AdfNode> | undefined): string {
  return (nodes ?? [])
    .map(block)
    .filter((text) => text !== "")
    .join("\n\n");
}

function list(node: AdfNode, ordered: boolean): string {
  const start = ordered ? Number(node.attrs?.["order"] ?? 1) || 1 : 1;
  return (node.content ?? [])
    .map((item, index) => {
      const bullet = ordered ? `${start + index}. ` : "- ";
      const done =
        item.type === "taskItem" ? (attr(item, "state") === "DONE" ? "[x] " : "[ ] ") : "";
      // A nested list sits right under its item's text, so the item stays one tight list entry.
      const body =
        item.type === "taskItem"
          ? inline(item.content)
          : (item.content ?? [])
              .map(block)
              .filter((text) => text !== "")
              .join("\n");
      return bullet + done + indent(body, " ".repeat(bullet.length));
    })
    .join("\n");
}

function table(node: AdfNode): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      blocks(cell.content).replaceAll("\n", " ").replaceAll("|", "\\|"),
    ),
  );
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return "";
  const line = (cells: ReadonlyArray<string>) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [line(head), line(Array(width).fill("---")), ...body.map(line)].join("\n");
}

function block(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return inline(node.content);
    case "heading":
      return `${"#".repeat(Math.min(Math.max(Number(node.attrs?.["level"]) || 1, 1), 6))} ${inline(node.content)}`;
    case "bulletList":
    case "taskList":
      return list(node, false);
    case "orderedList":
      return list(node, true);
    case "codeBlock": {
      const code = (node.content ?? []).map((child) => child.text ?? "").join("");
      const ticks = fence(code, 3);
      return `${ticks}${attr(node, "language") ?? ""}\n${code}\n${ticks}`;
    }
    case "blockquote":
    case "panel":
      return blocks(node.content)
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
    case "rule":
      return "---";
    case "table":
      return table(node);
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "_(attachment, open in Jira to view)_";
    case "expand":
    case "nestedExpand":
      return [attr(node, "title"), blocks(node.content)].filter(Boolean).join("\n\n");
    default:
      return node.content === undefined ? inlineNode(node) : blocks(node.content);
  }
}

/** Nodes whose Markdown form is a stand-in, so writing that Markdown back would lose them. */
const JIRA_ONLY = new Set([
  "media",
  "mediaSingle",
  "mediaGroup",
  "mediaInline",
  "mention",
  "emoji",
  "status",
  "date",
  "inlineCard",
  "blockCard",
  "embedCard",
  "panel",
  "expand",
  "nestedExpand",
  "extension",
  "bodiedExtension",
  "inlineExtension",
  "layoutSection",
  "decisionList",
]);

export function hasJiraOnlyContent(document: unknown): boolean {
  if (!isNode(document)) return false;
  const visit = (node: AdfNode): boolean =>
    JIRA_ONLY.has(node.type) ||
    Number(node.attrs?.["colspan"] ?? 1) > 1 ||
    Number(node.attrs?.["rowspan"] ?? 1) > 1 ||
    (node.marks ?? []).some((mark) => mark.type !== "link" && !MARKDOWN_MARKS.has(mark.type)) ||
    (node.content ?? []).some((child) => isNode(child) && visit(child));
  return visit(document);
}

const MARKDOWN_MARKS = new Set(["code", "strong", "em", "strike"]);

/** A Jira document as Markdown; an empty or absent one is the empty string. */
export function adfToMarkdown(document: unknown): string {
  if (typeof document === "string") return document;
  if (!isNode(document)) return "";
  return blocks(document.content).trim();
}

type Inline = AdfNode;

function inlineFromMdast(node: Mdast.PhrasingContent, marks: ReadonlyArray<AdfMark>): Inline[] {
  const children = (extra: AdfMark) =>
    "children" in node
      ? (node.children as Mdast.PhrasingContent[]).flatMap((child) =>
          inlineFromMdast(child, [...marks, extra]),
        )
      : [];
  switch (node.type) {
    case "text":
      return node.value === "" ? [] : [{ type: "text", text: node.value, ...withMarks(marks) }];
    case "inlineCode":
      // Jira only lets code combine with a link.
      return node.value === ""
        ? []
        : [
            {
              type: "text",
              text: node.value,
              ...withMarks([...marks.filter((mark) => mark.type === "link"), { type: "code" }]),
            },
          ];
    case "strong":
      return children({ type: "strong" });
    case "emphasis":
      return children({ type: "em" });
    case "delete":
      return children({ type: "strike" });
    case "link":
      return children({ type: "link", attrs: { href: node.url } });
    case "image":
      return [
        {
          type: "text",
          text: node.alt || node.url,
          ...withMarks([...marks, { type: "link", attrs: { href: node.url } }]),
        },
      ];
    case "break":
      return [{ type: "hardBreak" }];
    case "html":
      return node.value === "" ? [] : [{ type: "text", text: node.value, ...withMarks(marks) }];
    default:
      return "children" in node
        ? (node.children as Mdast.PhrasingContent[]).flatMap((child) =>
            inlineFromMdast(child, marks),
          )
        : [];
  }
}

function withMarks(marks: ReadonlyArray<AdfMark>): { marks?: AdfMark[] } {
  if (marks.length === 0) return {};
  const code = marks.some((mark) => mark.type === "code");
  const kept = code ? marks.filter((mark) => mark.type === "code" || mark.type === "link") : marks;
  return { marks: [...new Map(kept.map((mark) => [mark.type, mark])).values()] };
}

function paragraph(children: ReadonlyArray<Mdast.PhrasingContent>): AdfNode {
  const content = children.flatMap((child) => inlineFromMdast(child, []));
  return content.length === 0 ? { type: "paragraph" } : { type: "paragraph", content };
}

function blockFromMdast(node: Mdast.RootContent): AdfNode[] {
  switch (node.type) {
    case "paragraph":
      return [paragraph(node.children)];
    case "heading":
      return [
        {
          type: "heading",
          attrs: { level: node.depth },
          content: paragraph(node.children).content ?? [],
        },
      ];
    case "code":
      return [
        {
          type: "codeBlock",
          ...(node.lang ? { attrs: { language: node.lang } } : {}),
          ...(node.value === "" ? {} : { content: [{ type: "text", text: node.value }] }),
        },
      ];
    case "blockquote":
      return [{ type: "blockquote", content: node.children.flatMap(blockFromMdast) }];
    case "list":
      return [
        {
          type: node.ordered ? "orderedList" : "bulletList",
          ...(node.ordered && node.start != null && node.start !== 1
            ? { attrs: { order: node.start } }
            : {}),
          content: node.children.map((item) => {
            const content = item.children.flatMap(blockFromMdast);
            const checkbox = item.checked == null ? null : item.checked ? "[x] " : "[ ] ";
            const [first, ...rest] = content;
            // A list item must open with a paragraph in Jira.
            const opening: AdfNode =
              first?.type === "paragraph"
                ? checkbox === null
                  ? first
                  : {
                      ...first,
                      content: [{ type: "text", text: checkbox }, ...(first.content ?? [])],
                    }
                : {
                    type: "paragraph",
                    ...(checkbox === null ? {} : { content: [{ type: "text", text: checkbox }] }),
                  };
            return {
              type: "listItem",
              content: first?.type === "paragraph" ? [opening, ...rest] : [opening, ...content],
            };
          }),
        },
      ];
    case "thematicBreak":
      return [{ type: "rule" }];
    case "table":
      return [
        {
          type: "table",
          content: node.children.map((row, rowIndex) => ({
            type: "tableRow",
            content: row.children.map((cell) => ({
              type: rowIndex === 0 ? "tableHeader" : "tableCell",
              content: [paragraph(cell.children)],
            })),
          })),
        },
      ];
    case "html":
      return node.value.trim() === ""
        ? []
        : [{ type: "paragraph", content: [{ type: "text", text: node.value }] }];
    default:
      return [];
  }
}

/** Reference links as the inline links they stand for, since ADF has no definitions. */
function resolveReferences(node: Mdast.Nodes, definitions: ReadonlyMap<string, string>): void {
  if (!("children" in node)) return;
  node.children = node.children.map((child) => {
    const url = "identifier" in child ? definitions.get(child.identifier) : undefined;
    if (child.type === "linkReference" && url !== undefined)
      return { type: "link", url, children: child.children };
    if (child.type === "imageReference" && url !== undefined)
      return { type: "image", url, alt: child.alt ?? null };
    return child;
  }) as typeof node.children;
  for (const child of node.children) resolveReferences(child, definitions);
}

/** Markdown as a Jira document, the way Jira's own editor would have stored it. */
export function markdownToAdf(markdown: string) {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  // The first definition of an identifier wins, as in CommonMark.
  const definitions = new Map<string, string>();
  for (const child of tree.children) {
    if (child.type === "definition" && !definitions.has(child.identifier))
      definitions.set(child.identifier, child.url);
  }
  resolveReferences(tree, definitions);
  return { type: "doc", version: 1, content: tree.children.flatMap(blockFromMdast) };
}
