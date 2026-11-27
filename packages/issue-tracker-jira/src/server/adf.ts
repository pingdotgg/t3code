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

/** Jira's literal characters that markdown would read as syntax; `_` inside a word is inert. */
const escape = (text: string) =>
  text.replace(/[\\`*~[\]<&]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "\\$&");

/** Line openers that would make a paragraph a heading, quote, list or setext underline. */
const escapeLineStarts = (text: string) =>
  text.replace(/^([ \t]*)([#>+=-])/gm, "$1\\$2").replace(/^([ \t]*\d+)([.)])/gm, "$1\\$2");

/** A backtick run longer than any inside `code`, so the code cannot close its own fence. */
const fence = (code: string, least: number) =>
  "`".repeat(Math.max(least, ...(code.match(/`+/g) ?? []).map((run) => run.length + 1)));

function codeSpan(code: string): string {
  // A space keeps an edge backtick off the fence; markdown strips one from each end.
  const pad = /^`|`$|^ .*[^ ].* $/s.test(code) ? " " : "";
  const ticks = fence(code, 1);
  return `${ticks}${pad}${code}${pad}${ticks}`;
}

const ATTACHMENT = "_(attachment, open in Jira to view)_";

/** A link destination markdown reads back whole: parentheses escaped, spaces in angle brackets. */
function linked(text: string, marks: NonNullable<AdfNode["marks"]>): string {
  const href = marks.find((mark) => mark.type === "link")?.attrs?.["href"];
  if (typeof href !== "string") return text;
  const escaped = href.replace(/[\\()]/g, "\\$&");
  return `[${text}](${/\s/u.test(href) ? `<${href.replace(/[\\<>]/g, "\\$&")}>` : escaped})`;
}

function inline(node: AdfNode): string {
  switch (node.type) {
    case "text": {
      const marks = node.marks ?? [];
      const raw = node.text ?? "";
      if (marks.some((mark) => mark.type === "code")) {
        return linked(codeSpan(raw), marks);
      }
      // A delimiter beside whitespace does not close, so edge spaces stay outside the marks.
      const [, before = "", core = "", after = ""] = /^(\s*)(.*?)(\s*)$/su.exec(raw) ?? [];
      if (core.length === 0) return raw;
      let text = escape(core);
      for (const mark of marks) {
        if (mark.type === "strong") text = `**${text}**`;
        else if (mark.type === "em") text = `*${text}*`;
        else if (mark.type === "strike") text = `~~${text}~~`;
      }
      return `${before}${linked(text, marks)}${after}`;
    }
    case "hardBreak":
      return "\\\n";
    case "mention":
      return attr(node, "text") ?? "@someone";
    case "emoji":
      return attr(node, "text") ?? attr(node, "shortName") ?? "";
    case "inlineCard":
      return attr(node, "url") ?? "";
    case "status":
      return attr(node, "text") ?? "";
    case "date": {
      const at = Number(node.attrs?.["timestamp"]);
      return Option.match(DateTime.make(at), {
        onNone: () => "",
        onSome: (date) => DateTime.formatIso(date).slice(0, 10),
      });
    }
    case "mediaInline":
      return ATTACHMENT;
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
      // Paragraphs keep a blank line between them, or they read back as one; so does a nested
      // ordered list not starting at 1, which markdown would read as the paragraph's next line.
      const body = children(item)
        .map((child, at, all) => {
          const text = block(child);
          const next = all[at + 1];
          if (next === undefined) return text;
          const loose =
            next.type === "paragraph" ||
            (next.type === "orderedList" && (Number(next.attrs?.["order"]) || 1) !== 1);
          return `${text}${loose ? "\n\n" : "\n"}`;
        })
        .join("");
      return lead + indent(body, " ".repeat(lead.length)).slice(lead.length);
    })
    .join("\n");
}

function table(node: AdfNode): string {
  const rows = children(node).map((row) =>
    children(row).map((cell) =>
      blocks(children(cell), " ")
        .replaceAll("\\\n", " ")
        .replaceAll("\n", " ")
        .replaceAll("|", "\\|"),
    ),
  );
  // Merged cells leave rows of different lengths; the widest row sets the column count.
  const width = Math.max(0, ...rows.map((row) => row.length));
  const [head, ...rest] = rows;
  if (head === undefined || width === 0) return "";
  const line = (cells: ReadonlyArray<string>) =>
    `| ${[...cells, ...Array<string>(width - cells.length).fill("")].join(" | ")} |`;
  return [line(head), line(Array<string>(width).fill("---")), ...rest.map(line)].join("\n");
}

function block(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return escapeLineStarts(inlines(node));
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.["level"]) || 1));
      // A trailing `#` would read as the heading's closing sequence.
      return `${"#".repeat(level)} ${inlines(node).replace(/#+$/, "\\$&")}`;
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
    case "codeBlock": {
      const code = children(node)
        .map((child) => child.text ?? "")
        .join("");
      const ticks = fence(code, 3);
      return `${ticks}${attr(node, "language") ?? ""}\n${code}\n${ticks}`;
    }
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
      return ATTACHMENT;
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
  "emoji",
  "status",
  "date",
  "expand",
  "nestedExpand",
  "panel",
  "inlineCard",
  "blockCard",
  "embedCard",
]);

const WRITABLE_MARKS = new Set(["link", "code", "strong", "em", "strike"]);

const merged = (node: AdfNode) =>
  Number(node.attrs?.["colspan"] ?? 1) > 1 || Number(node.attrs?.["rowspan"] ?? 1) > 1;

export function hasUnwritableContent(document: unknown): boolean {
  if (!isNode(document)) return false;
  return (
    UNWRITABLE.has(document.type) ||
    merged(document) ||
    // A table cell is written back as one paragraph.
    ((document.type === "tableCell" || document.type === "tableHeader") &&
      (children(document).length > 1 ||
        children(document).some((child) => child.type !== "paragraph") ||
        // A line break in a cell is written back as a space.
        children(document).some((child) =>
          children(child).some((leaf) => leaf.type === "hardBreak"),
        ))) ||
    // A checklist is written back flat, so one nested in another would be lost.
    (document.type === "taskList" &&
      children(document).some((child) => child.type === "taskList")) ||
    (document.marks ?? []).some((mark) => !WRITABLE_MARKS.has(mark.type)) ||
    children(document).some(hasUnwritableContent)
  );
}

interface Mdast {
  readonly type: string;
  readonly value?: string;
  readonly depth?: number;
  readonly ordered?: boolean | null;
  readonly start?: number | null;
  readonly checked?: boolean | null;
  readonly position?: { readonly start: { readonly offset?: number } };
  readonly lang?: string | null;
  readonly url?: string;
  readonly alt?: string | null;
  readonly identifier?: string;
  readonly children?: ReadonlyArray<Mdast>;
}

type Mark = NonNullable<AdfNode["marks"]>[number];

/** Jira takes one mark of each type, and code beside nothing but a link; the outer mark wins. */
function text(value: string, marks: ReadonlyArray<Mark>): AdfNode[] {
  if (value.length === 0) return [];
  const code = marks.some((mark) => mark.type === "code");
  const kept = marks.filter(
    (mark, index) =>
      marks.findIndex((other) => other.type === mark.type) === index &&
      (!code || mark.type === "code" || mark.type === "link"),
  );
  return [{ type: "text", text: value, ...(kept.length === 0 ? {} : { marks: kept }) }];
}

function toInline(node: Mdast, marks: ReadonlyArray<Mark>): AdfNode[] {
  const within = (mark: Mark) =>
    (node.children ?? []).flatMap((child) => toInline(child, [...marks, mark]));
  switch (node.type) {
    case "text":
    case "html":
      return text(node.value ?? "", marks);
    case "inlineCode":
      return text(node.value ?? "", [...marks, { type: "code" }]);
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

/** Where the node starts in the markdown: unique within the document, as Jira asks of task ids. */
const localId = (node: Mdast) => `task-${node.position?.start.offset ?? 0}`;

/** Every item a box with a single line of text: what a Jira task list holds. */
function isChecklist(node: Mdast): boolean {
  const items = node.children ?? [];
  return (
    !node.ordered &&
    items.length > 0 &&
    items.every(
      (item) =>
        item.checked != null &&
        item.children?.length === 1 &&
        item.children[0]!.type === "paragraph",
    )
  );
}

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
      if (!nested && isChecklist(node)) {
        return [
          {
            type: "taskList",
            attrs: { localId: localId(node) },
            content: (node.children ?? []).map((item): AdfNode => ({
              type: "taskItem",
              attrs: { localId: localId(item), state: item.checked ? "DONE" : "TODO" },
              content: paragraph(item.children![0]!).content ?? [],
            })),
          },
        ];
      }
      return [
        {
          type: node.ordered ? "orderedList" : "bulletList",
          ...(node.ordered && node.start != null && node.start !== 1
            ? { attrs: { order: node.start } }
            : {}),
          content: (node.children ?? []).map((item) => {
            // A box Jira's task nodes cannot hold (nested content, a mixed list) stays as text.
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

/** ADF has no link definitions, so a reference becomes the link it names; the first one wins. */
function inlineReferences(root: Mdast): Mdast {
  const urls = new Map<string, string>();
  const collect = (node: Mdast): void => {
    if (node.type === "definition" && node.identifier !== undefined && !urls.has(node.identifier))
      urls.set(node.identifier, node.url ?? "");
    node.children?.forEach(collect);
  };
  const resolve = (node: Mdast): Mdast => {
    const url = node.identifier === undefined ? undefined : urls.get(node.identifier);
    const type =
      node.type === "linkReference" ? "link" : node.type === "imageReference" ? "image" : null;
    return {
      ...node,
      ...(type !== null && url !== undefined ? { type, url } : {}),
      ...(node.children === undefined ? {} : { children: node.children.map(resolve) }),
    };
  };
  collect(root);
  return resolve(root);
}

const parser = unified().use(remarkParse).use(remarkGfm);

export function markdownToAdf(markdown: string): AdfNode & { readonly version: 1 } {
  const root = inlineReferences(parser.parse(markdown) as Mdast);
  return {
    version: 1,
    type: "doc",
    content: (root.children ?? []).flatMap((child) => toBlocks(child, false)),
  };
}
