// mdast to the sanitized hast the chat renders, in one pass: what remark-rehype, the chat's
// rehype plugins and rehype-sanitize build for trees without raw HTML. Trees the HTML parser
// would change return null, and keep the rehype path.
import type { Element, ElementContent, Properties, Root as HastRoot, Text as HastText } from "hast";
import type {
  Definition,
  FootnoteDefinition,
  List,
  ListItem,
  Nodes,
  Parent,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from "mdast";

type Position = NonNullable<Root["position"]>;

export interface ToHastOptions {
  /** Extra href protocols the chat allows. */
  readonly hrefProtocols: ReadonlyArray<string>;
  readonly srcProtocols: ReadonlyArray<string>;
  readonly isWindowsDrivePathHref: (href: string) => boolean;
}

const CLOBBER_PREFIX = "user-content-";

class Bail extends Error {}

function copyPosition(position: Position | undefined): Position | undefined {
  if (!position) return undefined;
  return {
    start: { line: position.start.line, column: position.start.column, offset: position.start.offset },
    end: { line: position.end.line, column: position.end.column, offset: position.end.offset },
  } as Position;
}

function element(
  tagName: string,
  properties: Properties,
  children: ElementContent[],
  position?: Position,
): Element {
  const node: Element = { type: "element", tagName, properties, children };
  const copied = copyPosition(position);
  if (copied) node.position = copied;
  return node;
}

function text(value: string, position?: Position): HastText {
  const node: HastText = { type: "text", value };
  const copied = copyPosition(position);
  if (copied) node.position = copied;
  return node;
}

function trimSpaceStart(value: string): string {
  let index = 0;
  while (value.charCodeAt(index) === 9 || value.charCodeAt(index) === 32) index++;
  return value.slice(index);
}

const NEWLINE = (): HastText => ({ type: "text", value: "\n" });

function wrap(nodes: ElementContent[], loose: boolean): ElementContent[] {
  const result: ElementContent[] = [];
  if (loose) result.push(NEWLINE());
  for (let index = 0; index < nodes.length; index++) {
    if (index) result.push(NEWLINE());
    result.push(nodes[index]!);
  }
  if (loose && nodes.length > 0) result.push(NEWLINE());
  return result;
}

/** trim-lines: spaces and tabs around line endings go. */
function trimLines(value: string): string {
  if (!value.includes("\n") && !value.includes("\r")) return value;
  const search = /\r?\n|\r/g;
  let match = search.exec(value);
  let last = 0;
  let out = "";
  while (match) {
    out += trimLine(value.slice(last, match.index), last > 0, true) + match[0];
    last = match.index + match[0].length;
    match = search.exec(value);
  }
  return out + trimLine(value.slice(last), last > 0, false);
}

function trimLine(value: string, start: boolean, end: boolean): string {
  let startIndex = 0;
  let endIndex = value.length;
  if (start) {
    while (value.charCodeAt(startIndex) === 9 || value.charCodeAt(startIndex) === 32) startIndex++;
  }
  if (end) {
    while (value.charCodeAt(endIndex - 1) === 9 || value.charCodeAt(endIndex - 1) === 32) endIndex--;
  }
  return endIndex > startIndex ? value.slice(startIndex, endIndex) : "";
}

const isAsciiAlphanumeric = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const URI_SAFE = /[!#$&-;=?-Z_a-z~]/;

/** micromark-util-sanitize-uri's normalizeUri. */
export function normalizeUri(value: string): string {
  let out = "";
  let start = 0;
  let skip = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    let replace = "";
    if (code === 37 && isAsciiAlphanumeric(value.charCodeAt(index + 1)) && isAsciiAlphanumeric(value.charCodeAt(index + 2))) {
      skip = 2;
    } else if (code < 128) {
      if (!URI_SAFE.test(String.fromCharCode(code))) replace = String.fromCharCode(code);
    } else if (code > 55_295 && code < 57_344) {
      const next = value.charCodeAt(index + 1);
      if (code < 56_320 && next > 56_319 && next < 57_344) {
        replace = String.fromCharCode(code, next);
        skip = 1;
      } else {
        replace = "�";
      }
    } else {
      replace = String.fromCharCode(code);
    }
    if (replace) {
      out += value.slice(start, index) + encodeURIComponent(replace);
      start = index + skip + 1;
    }
    if (skip) {
      index += skip;
      skip = 0;
    }
  }
  return out + value.slice(start);
}

/** hast-util-sanitize's protocol check. */
function safeProtocol(url: string, protocols: ReadonlyArray<string>): boolean {
  const colon = url.indexOf(":");
  const questionMark = url.indexOf("?");
  const numberSign = url.indexOf("#");
  const slash = url.indexOf("/");
  if (
    colon < 0 ||
    (slash > -1 && colon > slash) ||
    (questionMark > -1 && colon > questionMark) ||
    (numberSign > -1 && colon > numberSign)
  ) {
    return true;
  }
  return protocols.some((protocol) => colon === protocol.length && url.startsWith(protocol));
}

const HREF_PROTOCOLS = ["http", "https", "irc", "ircs", "mailto", "xmpp"];
const SRC_PROTOCOLS = ["http", "https"];

interface FootnoteState {
  readonly order: string[];
  readonly counts: Map<string, number>;
}

class Converter {
  readonly definitions = new Map<string, Definition>();
  readonly footnoteDefinitions = new Map<string, FootnoteDefinition>();
  readonly footnotes: FootnoteState = { order: [], counts: new Map() };
  readonly hrefProtocols: ReadonlyArray<string>;
  readonly srcProtocols: ReadonlyArray<string>;
  readonly options: ToHastOptions;
  insideLink = 0;

  constructor(tree: Root, options: ToHastOptions) {
    this.options = options;
    this.hrefProtocols = [...HREF_PROTOCOLS, ...options.hrefProtocols];
    this.srcProtocols = [...SRC_PROTOCOLS, ...options.srcProtocols];
    const collect = (node: Nodes) => {
      if (node.type === "definition") {
        const id = node.identifier.toUpperCase();
        if (!this.definitions.has(id)) this.definitions.set(id, node);
      } else if (node.type === "footnoteDefinition") {
        const id = node.identifier.toUpperCase();
        if (!this.footnoteDefinitions.has(id)) this.footnoteDefinitions.set(id, node);
      }
      if ("children" in node) for (const child of node.children) collect(child as Nodes);
    };
    collect(tree);
  }

  href(url: string): string | undefined {
    const value = normalizeUri(url);
    return safeProtocol(value, this.hrefProtocols) ? value : undefined;
  }

  all(parent: Parent): ElementContent[] {
    const out: ElementContent[] = [];
    const children = parent.children as RootContent[];
    for (let index = 0; index < children.length; index++) {
      let result = this.one(children[index]!, parent);
      if (result === undefined) continue;
      // After a hard break, the next line's leading whitespace goes.
      if (index > 0 && children[index - 1]!.type === "break" && !Array.isArray(result)) {
        if (result.type === "text") result = { ...result, value: trimSpaceStart(result.value) };
        else if (result.type === "element") {
          const head = result.children[0];
          if (head?.type === "text") head.value = trimSpaceStart(head.value);
        }
      }
      if (Array.isArray(result)) out.push(...result);
      else out.push(result);
    }
    return out;
  }

  /** applyData: hName, hProperties and hChildren from remark plugins. */
  applyData(node: Nodes, result: ElementContent): ElementContent {
    const data = (node as { data?: { hName?: string; hProperties?: Properties; hChildren?: ElementContent[] } }).data;
    if (!data) return result;
    let out = result;
    if (data.hName) {
      out =
        out.type === "element"
          ? { ...out, tagName: data.hName }
          : element(data.hName, {}, "children" in out ? (out.children as ElementContent[]) : [out]);
      if (result.position && !out.position) out.position = result.position;
    }
    if (out.type === "element" && data.hProperties) {
      const properties: Properties = { ...out.properties };
      // Values are primitives or lists of them, so a shallow copy is a full one.
      for (const key in data.hProperties) {
        const value = data.hProperties[key];
        properties[key] = Array.isArray(value) ? [...value] : value;
      }
      out.properties = properties;
    }
    if ("children" in out && data.hChildren) {
      (out as Element).children = structuredClone(data.hChildren);
    }
    return out;
  }

  /** rehypeTextDirection isolates code outside `pre` left to right. */
  isolate(node: ElementContent): ElementContent {
    if (node.type === "element" && node.tagName === "code") node.properties = { ...node.properties, dir: "ltr" };
    return node;
  }

  hasHeading = false;
  hasRaw = false;

  one(node: RootContent, parent: Parent): ElementContent | ElementContent[] | undefined {
    const position = node.position;
    switch (node.type) {
      case "paragraph":
        return this.applyData(node, element("p", {}, this.all(node), position));
      case "heading":
        this.hasHeading = true;
        return this.applyData(node, element(`h${node.depth}`, {}, this.all(node), position));
      case "thematicBreak":
        return this.applyData(node, element("hr", {}, [], position));
      case "blockquote":
        return this.applyData(node, element("blockquote", {}, wrap(this.all(node), true), position));
      case "break":
        return [this.applyData(node, element("br", {}, [], position)), text("\n")];
      case "text":
        return this.applyData(node, text(trimLines(node.value), position));
      case "emphasis":
        return this.applyData(node, element("em", {}, this.all(node), position));
      case "strong":
        return this.applyData(node, element("strong", {}, this.all(node), position));
      case "delete":
        return this.applyData(node, element("del", {}, this.all(node), position));
      case "inlineCode": {
        const code = element("code", {}, [text(node.value.replace(/\r?\n|\r/g, " "), position)], position);
        return this.isolate(this.applyData(node, code));
      }
      case "code": {
        const value = node.value ? `${node.value}\n` : "";
        const properties: Properties = {};
        const lang = node.lang ? node.lang.split(/\s+/)[0] : undefined;
        if (lang) properties.className = [`language-${lang}`];
        const code = this.applyData(node, element("code", properties, [text(value)], position));
        return element("pre", {}, [code], position);
      }
      case "link":
      case "linkReference": {
        let url: string;
        if (node.type === "linkReference") {
          const definition = this.definitions.get(node.identifier.toUpperCase());
          if (!definition) throw new Bail();
          url = definition.url;
        } else url = node.url;
        if (this.insideLink > 0) throw new Bail();
        this.insideLink++;
        const children = this.all(node);
        this.insideLink--;
        const properties: Properties = {};
        const href = this.href(url);
        if (href !== undefined) properties.href = href;
        return this.applyData(node, element("a", properties, children, position));
      }
      case "image":
      case "imageReference": {
        let url: string;
        if (node.type === "imageReference") {
          const definition = this.definitions.get(node.identifier.toUpperCase());
          if (!definition) throw new Bail();
          url = definition.url;
        } else url = node.url;
        const properties: Properties = {};
        const src = normalizeUri(url);
        const title = node.type === "image" ? node.title : this.definitions.get(node.identifier.toUpperCase())?.title;
        // rehypePreserveImageSourceMeta reads src and title before sanitizing drops them.
        if (safeProtocol(src, this.srcProtocols)) properties.src = src;
        properties.alt = node.alt ?? "";
        if (this.options.isWindowsDrivePathHref(src)) properties.dataLocalSrc = src;
        if (typeof title === "string") properties.dataMarkdownTitle = title;
        return this.applyData(node, element("img", properties, [], position));
      }
      case "list":
        return this.list(node);
      case "listItem":
        return this.listItem(node, parent);
      case "table":
        return this.table(node);
      case "footnoteReference":
        return this.footnoteReference(node.identifier, position);
      case "html":
        this.hasRaw = true;
        return { type: "raw", value: node.value, position: copyPosition(position) } as unknown as ElementContent;
      case "definition":
      case "footnoteDefinition":
      case "yaml" as never:
        return undefined;
      default: {
        const unknown = node as Nodes;
        const data = (unknown as { data?: { hName?: string } }).data;
        if ("value" in unknown && !data?.hName) {
          return this.applyData(unknown, text(String(unknown.value), position));
        }
        const children = "children" in unknown ? this.all(unknown as Parent) : [];
        const result = this.applyData(unknown, element("div", {}, children, position));
        return parent.type === "root" ? result : this.isolate(result);
      }
    }
  }

  list(node: List): Element {
    const properties: Properties = {};
    const tagName = node.ordered ? "ol" : "ul";
    const results: ElementContent[] = [];
    for (const child of node.children) results.push(this.listItem(child, node));
    if (typeof node.start === "number" && node.start !== 1) properties.start = node.start;
    if (node.children.some((item) => typeof item.checked === "boolean")) {
      properties.className = ["contains-task-list"];
    }
    return this.applyData(node, element(tagName, properties, wrap(results, true), node.position)) as Element;
  }

  listItem(node: ListItem, parent: Parent | undefined): Element {
    const results = this.all(node);
    const loose = parent ? listLoose(parent) : listItemLoose(node);
    const properties: Properties = {};
    const children: ElementContent[] = [];
    if (typeof node.checked === "boolean") {
      const head = results[0];
      let paragraph: Element;
      if (head && head.type === "element" && head.tagName === "p") paragraph = head;
      else {
        paragraph = element("p", {}, []);
        results.unshift(paragraph);
      }
      if (paragraph.children.length > 0) paragraph.children.unshift(text(" "));
      // Normalized as hast-util-to-parse5 would: a false `checked` is dropped.
      const input: Properties = { type: "checkbox", disabled: true };
      if (node.checked) input.checked = true;
      paragraph.children.unshift(element("input", input, []));
      properties.className = ["task-list-item"];
    }
    for (let index = 0; index < results.length; index++) {
      const child = results[index]!;
      if (loose || index !== 0 || child.type !== "element" || child.tagName !== "p") {
        children.push(NEWLINE());
      }
      if (child.type === "element" && child.tagName === "p" && !loose) children.push(...child.children);
      else children.push(child);
    }
    const tail = results.at(-1);
    if (tail && (loose || tail.type !== "element" || tail.tagName !== "p")) children.push(NEWLINE());
    return this.applyData(node, element("li", properties, children, node.position)) as Element;
  }

  table(node: Table): Element {
    const rows = node.children;
    const align = node.align ?? [];
    const rowElements = rows.map((row, rowIndex) => {
      const tagName = rowIndex === 0 ? "th" : "td";
      const length = align.length;
      const cells: ElementContent[] = [];
      for (let index = 0; index < length; index++) {
        const cell = row.children[index];
        const properties: Properties = {};
        const alignValue = align[index];
        if (alignValue) properties.align = alignValue;
        cells.push(
          cell
            ? (this.applyData(cell, element(tagName, properties, this.all(cell), cell.position)) as Element)
            : element(tagName, properties, []),
        );
      }
      return this.applyData(row, element("tr", {}, wrap(cells, true), row.position)) as Element;
    });
    const firstRow = rowElements.shift()!;
    const head = element("thead", {}, wrap([firstRow], true), rows[0]?.position);
    const sections: ElementContent[] = [head];
    if (rowElements.length > 0) {
      const start = rows[1]?.position?.start;
      const end = rows.at(-1)?.position?.end;
      sections.push(
        element(
          "tbody",
          {},
          wrap(rowElements, true),
          start && end ? ({ start, end } as Position) : undefined,
        ),
      );
    }
    return this.applyData(node, element("table", {}, wrap(sections, true), node.position)) as Element;
  }

  footnoteReference(identifier: string, position: Position | undefined): Element {
    if (this.insideLink > 0) throw new Bail();
    const id = identifier.toUpperCase();
    const safeId = normalizeUri(id.toLowerCase());
    const index = this.footnotes.order.indexOf(id);
    let counter: number;
    const reuse = (this.footnotes.counts.get(id) ?? 0) + 1;
    if (index === -1) {
      this.footnotes.order.push(id);
      counter = this.footnotes.order.length;
    } else counter = index + 1;
    this.footnotes.counts.set(id, reuse);
    // Sanitizing prefixes ids and aria references a second time.
    const link = element(
      "a",
      {
        href: `#${CLOBBER_PREFIX}fn-${safeId}`,
        id: `${CLOBBER_PREFIX}${CLOBBER_PREFIX}fnref-${safeId}${reuse > 1 ? `-${reuse}` : ""}`,
        dataFootnoteRef: "",
        ariaDescribedBy: [`${CLOBBER_PREFIX}footnote-label`],
      },
      [text(String(counter))],
      position,
    );
    return element("sup", {}, [link], position);
  }

  footer(): Element | undefined {
    const listItems: ElementContent[] = [];
    for (let index = 0; index < this.footnotes.order.length; index++) {
      const id = this.footnotes.order[index]!;
      const definition = this.footnoteDefinitions.get(id);
      if (!definition) continue;
      const content = this.all(definition);
      const safeId = normalizeUri(id.toLowerCase());
      const count = this.footnotes.counts.get(id) ?? 0;
      const backReferences: ElementContent[] = [];
      for (let reference = 1; reference <= count; reference++) {
        if (backReferences.length > 0) backReferences.push(text(" "));
        const children: ElementContent[] = [text("↩")];
        if (reference > 1) children.push(element("sup", {}, [text(String(reference))]));
        backReferences.push(
          element(
            "a",
            {
              href: `#${CLOBBER_PREFIX}fnref-${safeId}${reference > 1 ? `-${reference}` : ""}`,
              dataFootnoteBackref: "",
              ariaLabel: `Back to reference ${index + 1}${reference > 1 ? `-${reference}` : ""}`,
              className: ["data-footnote-backref"],
            },
            children,
          ),
        );
      }
      const tail = content.at(-1);
      if (tail && tail.type === "element" && tail.tagName === "p") {
        const tailTail = tail.children.at(-1);
        if (tailTail && tailTail.type === "text") tailTail.value += " ";
        else tail.children.push(text(" "));
        tail.children.push(...backReferences);
      } else {
        content.push(...backReferences);
      }
      listItems.push(
        element("li", { id: `${CLOBBER_PREFIX}${CLOBBER_PREFIX}fn-${safeId}` }, wrap(content, true), definition.position),
      );
    }
    if (listItems.length === 0) return undefined;
    return element("section", { dataFootnotes: "", className: ["footnotes"] }, [
      element("h2", { className: ["sr-only"], id: `${CLOBBER_PREFIX}footnote-label` }, [text("Footnotes")]),
      NEWLINE(),
      element("ol", {}, wrap(listItems, true)),
      NEWLINE(),
    ]);
  }
}

function listLoose(node: Parent): boolean {
  if ((node as List).spread) return true;
  return (node.children as ListItem[]).some((child) => listItemLoose(child));
}

function listItemLoose(node: ListItem): boolean {
  return node.spread ?? node.children.length > 1;
}

const STANDALONE_IMAGE_BLOCKS = new Set(["p", "div", "li", "td", "th", "figure", "center", "blockquote"]);

function meaningful(node: Element | HastRoot): ElementContent[] {
  return (node.children as ElementContent[]).filter(
    (child) => !(child.type === "text" && child.value.trim() === ""),
  );
}

function soleImage(node: Element | HastRoot): Element | undefined {
  const children = meaningful(node);
  if (children.length !== 1) return undefined;
  const only = children[0]!;
  if (only.type !== "element") return undefined;
  if (only.tagName === "img") return only;
  return only.tagName === "a" || only.tagName === "strong" || only.tagName === "em" ? soleImage(only) : undefined;
}

export function markStandaloneImages(node: Element | HastRoot) {
  if (node.type === "root" || STANDALONE_IMAGE_BLOCKS.has(node.tagName)) {
    const image = soleImage(node);
    if (image) image.properties = { ...image.properties, dataStandalone: true };
  }
  for (const child of node.children) if (child.type === "element") markStandaloneImages(child);
}

/** The chat's sanitized hast for `tree`, or null when the HTML parser would change it. */
export function toChatHast(
  tree: Root,
  options: ToHastOptions,
): { hast: HastRoot; hasHeading: boolean; hasRaw: boolean } | null {
  const converter = new Converter(tree, options);
  let children: ElementContent[];
  try {
    children = wrap(converter.all(tree), false);
  } catch (error) {
    if (error instanceof Bail) return null;
    throw error;
  }
  const footer = converter.footer();
  if (footer) children.push(NEWLINE(), footer);
  const root: HastRoot = { type: "root", children };
  const position = copyPosition(tree.position);
  if (position) root.position = position;
  return { hast: root, hasHeading: converter.hasHeading, hasRaw: converter.hasRaw };
}

export type { PhrasingContent };
