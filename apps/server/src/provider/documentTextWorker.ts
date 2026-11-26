// @effect-diagnostics nodeBuiltinImport:off -- isolated CLI worker; no server runtime is loaded here.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { characterEntities } from "character-entities";
import { SaxesParser } from "saxes";
import * as Yauzl from "yauzl";
import { terminalOutputCollapseRedraws } from "@t3tools/shared/terminalOutput";

const MAX_INPUT = 16 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
const MAX_OUTPUT = 1_000_000;
const CELL_START = Symbol("cell-start");
const CELL_END = Symbol("cell-end");
const LINE_START = Symbol("line-start");
const THEMATIC_BREAK = Symbol("thematic-break");
const MARKUP_COMPATIBILITY_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";
type TextPart =
  | string
  | typeof CELL_START
  | typeof CELL_END
  | typeof LINE_START
  | typeof THEMATIC_BREAK
  | { imageDescription: string }
  | { fallback: string };

const TRUNCATED = "\n\n[Extracted text truncated at document extraction limits.]";
// Parts the document never displays: the XHTML head, tracked deletions and moves, field codes,
// phonetic guides, paragraph properties such as tab-stop definitions, drawing anchor layout
// values and encoded field data.
const HIDDEN = new Set([
  "head",
  "script",
  "style",
  "binary-data",
  "rPh",
  "delText",
  "moveFrom",
  "instrText",
  "delInstrText",
  "tracked-changes",
  "pPr",
  "positionH",
  "positionV",
  "sizeRelH",
  "sizeRelV",
  "fldData",
  // An OpenDocument index keeps its templates beside the generated index; only the latter is content.
  "table-of-content-source",
  "illustration-index-source",
  "table-index-source",
  "object-index-source",
  "user-index-source",
  "alphabetical-index-source",
  "bibliography-source",
]);

// @effect-diagnostics-next-line extendsNativeError:off - this worker loads no Effect runtime; Truncation is a local throw sentinel.
class Truncation extends Error {}

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: Array<XmlNode | string>;
  imageDescription?: string;
  spaceCount?: number;
  hasText?: boolean;
  hasTextChoice?: boolean;
  markupCompatibility?: boolean;
  hasSelectedChoice?: boolean;
  epubTable?: boolean;
}

// ODF 1.3 Part 3 §6.1.2: paragraph character data turns TAB, CR and LF into spaces, collapses
// space runs and trims the ends; only <text:s>, <text:tab> and <text:line-break> keep literal ones.
function collapseOdfWhitespace(paragraph: XmlNode) {
  let afterSpace = true;
  let tail: { node: XmlNode; index: number; value: string } | undefined;
  const visit = (node: XmlNode) => {
    for (const [index, child] of node.children.entries()) {
      if (typeof child !== "string") {
        if (HIDDEN.has(child.name)) continue;
        if (child.spaceCount === undefined && !["tab", "line-break", "p", "h"].includes(child.name))
          visit(child);
        else {
          afterSpace = false;
          tail = undefined;
        }
        continue;
      }
      let value = child.replaceAll(/[ \t\r\n]+/g, " ");
      if (afterSpace && value.startsWith(" ")) value = value.slice(1);
      if (value) {
        afterSpace = value.endsWith(" ");
        tail = { node, index, value };
      }
      node.children[index] = value;
    }
  };
  visit(paragraph);
  if (tail && afterSpace) tail.node.children[tail.index] = tail.value.slice(0, -1);
}

function separateRubyReadings(ruby: XmlNode) {
  const parts = ruby.children.filter((part) =>
    typeof part === "string"
      ? part.trim() !== ""
      : !HIDDEN.has(part.name) && (part.name !== "rp" || part.hasText),
  );
  const isFallback = (part: XmlNode | string | undefined) =>
    typeof part !== "string" && part?.name === "rp";
  for (const [index, part] of parts.entries()) {
    if (typeof part === "string" || part.name !== "rt" || !part.hasText) continue;
    if (isFallback(parts[index - 1]) || isFallback(parts[index + 1])) continue;
    part.children.unshift("(");
    part.children.push(")");
  }
}

function xml(source: string, extension: string): XmlNode {
  const odf = [".odt", ".ods", ".odp"].includes(extension);
  const root: XmlNode = { name: "root", attrs: {}, children: [] };
  const stack = [root];
  let nodes = 0;
  const parser = new SaxesParser();
  if (extension === ".epub") Object.assign(parser.ENTITIES, characterEntities);
  parser.on("opentag", (tag) => {
    if (++nodes > 200_000 || stack.length > 128) throw new Truncation("XML structure limit");
    const node: XmlNode = {
      name: tag.name.split(":").at(-1)!,
      attrs: Object.fromEntries(
        Object.entries(tag.attributes).flatMap(([key, value]) => {
          const local = key.split(":").at(-1)!;
          // XHTML table spans are unqualified; a prefixed colspan is a foreign attribute.
          return extension === ".epub" && (local === "colspan" || local === "rowspan")
            ? [[key, String(value)]]
            : [
                [key, String(value)],
                [local, String(value)],
              ];
        }),
      ),
      children: [],
    };
    if (extension === ".epub" && node.name === "table") node.epubTable = true;
    if (odf && node.name === "s") node.spaceCount = repeatCount(node.attrs.c);
    stack.at(-1)!.children.push(node);
    stack.push(node);
    if (node.name === "AlternateContent" || node.name === "Choice") {
      const colon = tag.name.lastIndexOf(":");
      const binding = colon === -1 ? "xmlns" : `xmlns:${tag.name.slice(0, colon)}`;
      if (
        stack.findLast((ancestor) => Object.hasOwn(ancestor.attrs, binding))?.attrs[binding] ===
        MARKUP_COMPATIBILITY_NS
      )
        node.markupCompatibility = true;
    }
  });
  parser.on("closetag", (tag) => {
    const node = stack.pop()!;
    const parent = stack.at(-1)!;
    const isCompatibilityChoice =
      node.name === "Choice" &&
      node.markupCompatibility &&
      parent.name === "AlternateContent" &&
      parent.markupCompatibility;
    if (odf && (node.name === "p" || node.name === "h")) collapseOdfWhitespace(node);
    if (
      (extension === ".epub" &&
        (stack[1] ?? node).name === "html" &&
        Object.hasOwn(tag.attributes, "hidden") &&
        !/^until-found$/i.test(String(tag.attributes.hidden))) ||
      (extension === ".docx" && node.name === "del") ||
      (extension === ".docx" &&
        node.name === "r" &&
        children(node)
          .flatMap((child) => (child.name === "rPr" ? children(child) : []))
          .some(
            (prop) => prop.name === "vanish" && ["true", "1", "on"].includes(prop.attrs.val ?? "1"),
          )) ||
      (odf && node.name === "annotation" && parent.name !== "semantics") ||
      (extension === ".pptx" &&
        node.name === "timing" &&
        stack.every((ancestor) =>
          ["root", "sld", "AlternateContent", "Choice", "Fallback"].includes(ancestor.name),
        )) ||
      (extension === ".odp" &&
        node.name === "page-thumbnail" &&
        stack.some((ancestor) => ancestor.name === "notes")) ||
      (isCompatibilityChoice && parent.hasSelectedChoice)
    ) {
      parent.children.pop();
      return;
    }
    if (extension === ".epub" && node.name === "ruby" && stack[1]?.name === "html")
      separateRubyReadings(node);
    if (node.name === "Fallback" && !retainCompatibilityFallback(parent, node)) return;
    const alt = tag.attributes.alt;
    if (
      extension === ".epub" &&
      node.name === "img" &&
      stack[1]?.name === "html" &&
      alt?.trim() &&
      !/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!important\s*)?(?:;|$)/i.test(
        String(tag.attributes.style ?? ""),
      )
    ) {
      node.imageDescription = alt;
      node.hasText = true;
    }
    if (HIDDEN.has(node.name) || (!node.hasText && node.name !== "noBreakHyphen")) return;
    parent.hasText = true;
    if (node.name === "Choice") parent.hasTextChoice = true;
    if (isCompatibilityChoice) {
      parent.hasSelectedChoice = true;
      parent.children = parent.children.filter(
        (child) =>
          child === node ||
          typeof child === "string" ||
          !(child.name === "Choice" && child.markupCompatibility),
      );
    }
  });
  const text = (value: string) => {
    const node = stack.at(-1)!;
    node.children.push(value);
    if (value.trim() !== "") node.hasText = true;
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.write(source).close();
  return root;
}

const children = (node: XmlNode | undefined) =>
  node?.children.filter((child): child is XmlNode => typeof child !== "string") ?? [];

function slideRelationshipId(slide: XmlNode, inheritedAttributes: XmlNode["attrs"]) {
  for (const [name, value] of Object.entries(slide.attrs)) {
    if (!name.endsWith(":id")) continue;
    const binding = `xmlns:${name.slice(0, -3)}`;
    const namespace = slide.attrs[binding] ?? inheritedAttributes[binding];
    if (
      namespace === "http://schemas.openxmlformats.org/officeDocument/2006/relationships" ||
      namespace === "http://purl.oclc.org/ooxml/officeDocument/relationships"
    )
      return value;
  }
  return slide.attrs["r:id"] ?? slide.attrs.id;
}

function retainCompatibilityFallback(parent: XmlNode, fallback: XmlNode): boolean {
  // Markup-compatibility fallbacks repeat their mc:Choice content, e.g. Word text boxes.
  // Keep one when no Choice carries text, such as a chart with a VML caption.
  if (parent.hasTextChoice) {
    parent.children.pop();
    return false;
  }
  if (fallback.hasText || hasInlineTab(fallback, ["tab", "ptab"])) {
    parent.children = parent.children.filter(
      (child) =>
        typeof child === "string" || child.name !== "Choice" || !hasInlineTab(child, ["ptab"]),
    );
  }
  return true;
}

function hasInlineTab(node: XmlNode, names: readonly string[]): boolean {
  return (
    !HIDDEN.has(node.name) &&
    (names.includes(node.name) || children(node).some((child) => hasInlineTab(child, names)))
  );
}
function* all(
  node: XmlNode,
  name: string | readonly string[],
  skip: readonly string[] = [],
): Generator<XmlNode, void> {
  for (const child of children(node)) {
    if (typeof name === "string" ? child.name === name : name.includes(child.name)) yield child;
    else if (!skip.includes(child.name)) yield* all(child, name, skip);
  }
}
function* text(node: XmlNode): Generator<TextPart, void> {
  if (HIDDEN.has(node.name)) return;
  if (node.imageDescription !== undefined) {
    yield { imageDescription: node.imageDescription };
    return;
  }
  // Word text boxes hold their own paragraphs inside the anchoring paragraph.
  if (node.name === "txbxContent") yield* paragraphs(node);
  else if (["tab", "ptab", "cell"].includes(node.name)) yield "\t";
  else if (["br", "line-break", "cr"].includes(node.name)) yield "\n";
  else if (node.name === "noBreakHyphen") yield "\u2011";
  else if (node.spaceCount !== undefined) {
    yield " ".repeat(Math.min(MAX_OUTPUT, node.spaceCount));
    if (node.spaceCount > MAX_OUTPUT) throw new Truncation("Space repeat limit");
  } else
    for (const child of node.children) {
      if (typeof child === "string") yield child;
      else yield* text(child);
    }
}
// SpreadsheetML `t` and `v` values are ST_Xstring: `_xHHHH_` is one UTF-16 code unit, and an
// escaped lead underscore (`_x005F_xHHHH_`) keeps the literal `_xHHHH_`. Decoded in one pass.
function* xstringText(node: XmlNode): Generator<string, void> {
  if (HIDDEN.has(node.name)) return;
  if (node.name !== "t" && node.name !== "v") {
    for (const child of children(node)) yield* xstringText(child);
    return;
  }
  yield node.children
    .filter((child) => typeof child === "string")
    .join("")
    .replaceAll(
      /_x005[Ff]_(x[\dA-Fa-f]{4}_)|_x([\dA-Fa-f]{4})_/g,
      (_, literal?: string, hex?: string) =>
        literal ? `_${literal}` : String.fromCharCode(Number.parseInt(hex!, 16)),
    );
}
function* paragraphs(node: XmlNode): Generator<TextPart, void> {
  if (HIDDEN.has(node.name)) return;
  if (node.imageDescription !== undefined) {
    yield* text(node);
    return;
  }
  for (const child of node.children) {
    if (typeof child === "string") yield child;
    else if (["br", "line-break", "cr"].includes(child.name)) yield "\n";
    else if (child.name === "hr") yield THEMATIC_BREAK;
    else if (["tbl", "table"].includes(child.name)) yield* table(child);
    else if (child.name === "pre" && child.hasText) {
      yield LINE_START;
      yield* text(child);
      yield LINE_START;
    } else if (["p", "h"].includes(child.name) || /^h[1-6]$/.test(child.name)) {
      yield THEMATIC_BREAK;
      const style =
        all(child, "pStyle", ["pPrChange", "txbxContent"]).next().value?.attrs.val ?? "";
      const level =
        child.name === "h"
          ? Number(child.attrs["outline-level"]) || 1
          : /^h[1-6]$/.test(child.name)
            ? Number(child.name[1])
            : Number(style.match(/^Heading([1-6])$/i)?.[1]) || 0;
      if (level) yield `${"#".repeat(Math.min(6, level))} `;
      yield* text(child);
      yield "\n";
    } else if (
      ["blockquote", "figcaption", "aside", "address"].includes(child.name) &&
      child.hasText
    ) {
      yield LINE_START;
      yield* paragraphs(child);
      yield LINE_START;
    } else {
      if (["ol", "ul", "dl"].includes(child.name)) {
        if (!child.hasText) continue;
        yield LINE_START;
      }
      const block = ["li", "div", "section", "dt", "dd"].includes(child.name);
      // Like a thematic break, a nested block starts a new line once its content arrives.
      if (block) yield THEMATIC_BREAK;
      yield* paragraphs(child);
      if (block) yield "\n";
    }
  }
}
// A notes page also holds the slide image, slide number, date, header and footer placeholders.
const NOTES_PAGE_PLACEHOLDERS = new Set(["sldImg", "sldNum", "dt", "hdr", "ftr"]);
const isNotesPagePlaceholder = (node: XmlNode) =>
  node.name === "sp" && NOTES_PAGE_PLACEHOLDERS.has(all(node, "ph").next().value?.attrs.type ?? "");
function withoutNotesPagePlaceholders(node: XmlNode): XmlNode {
  return {
    ...node,
    children: node.children
      .filter((child) => typeof child === "string" || !isNotesPagePlaceholder(child))
      .map((child) => (typeof child === "string" ? child : withoutNotesPagePlaceholders(child))),
  };
}
function* inCell(parts: Iterable<TextPart>): Generator<TextPart, void> {
  yield CELL_START;
  yield* parts;
  yield CELL_END;
}
function repeatCount(value: string | undefined): number {
  if (value === undefined) return 1;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1) throw new Error("Invalid repeat count");
  return Number(value);
}
function odfValue(cell: XmlNode): string {
  const type = cell.attrs["office:value-type"] ?? cell.attrs["value-type"];
  const attr = (name: string) => cell.attrs[`office:${name}`] ?? cell.attrs[name] ?? "";
  switch (type) {
    case "void":
      return "";
    case "string":
      return attr("string-value");
    case "boolean":
      return attr("boolean-value");
    case "date":
      return attr("date-value");
    case "time":
      return attr("time-value");
    case "currency":
      return attr("value").trim() ? `${attr("value")} ${attr("currency")}`.trim() : "";
    case "percentage":
      return attr("value").trim() ? `${attr("value")} [ODF value-type=percentage]` : "";
    default:
      return attr("value");
  }
}
const covered = (cell: XmlNode) => cell.name === "covered-table-cell";
function hasCellText(cell: XmlNode): boolean {
  if (covered(cell)) return false;
  if (cell.imageDescription !== undefined || odfValue(cell).trim() || cell.name === "noBreakHyphen")
    return true;
  // Space markers can have enormous repeat counts; emptiness never requires expanding them.
  if (HIDDEN.has(cell.name) || cell.spaceCount !== undefined) return false;
  return cell.children.some((child) =>
    typeof child === "string" ? !!child.trim() : hasCellText(child),
  );
}
function epubSpan(value: string | undefined) {
  const digits = value?.match(/^[\t\n\f\r ]*\+?([0-9]+)/)?.[1];
  return digits === undefined ? 1 : Number(digits);
}

function* epubTable(node: XmlNode): Generator<TextPart, void> {
  const occupiedUntil = new Uint32Array(512);
  let rowIndex = 0;
  let rowCount = 0;
  for (const part of children(node)) {
    const rowGroup = ["thead", "tbody", "tfoot"].includes(part.name);
    if (!rowGroup && part.name !== "tr") continue;
    if (rowGroup) occupiedUntil.fill(0);
    for (const row of rowGroup ? children(part) : [part]) {
      if (row.name !== "tr") continue;
      rowIndex++;
      const cells = children(row)
        .filter((cell) => cell.name === "td" || cell.name === "th")
        .map((cell) => ({ cell, rowSpan: epubSpan(cell.attrs.rowspan) }));
      const lastText = cells.findLastIndex(({ cell }) => hasCellText(cell));
      if (lastText >= 0 && ++rowCount > 10_000) throw new Truncation("Row limit");
      if (lastText >= 0 && rowCount === 1) yield LINE_START;
      // An empty cell can still reserve columns in later rows.
      const lastCell = Math.max(
        lastText,
        cells.findLastIndex(({ rowSpan }) => rowSpan !== 1),
      );
      let column = 0;
      let lastColumn = 0;
      for (let index = 0; index <= lastCell; index++) {
        const { cell, rowSpan } = cells[index]!;
        while ((occupiedUntil[column] ?? 0) > rowIndex) column++;
        const width = Math.max(1, Math.min(1000, epubSpan(cell.attrs.colspan)));
        const endColumn = column + width;
        const inBounds = column < occupiedUntil.length;
        if (!inBounds && hasCellText(cell)) throw new Truncation("Column limit");
        if (rowSpan !== 1) {
          // A zero row span covers the rest of the row group.
          const endRow = rowSpan === 0 ? 0xffffffff : rowIndex + Math.min(65_534, rowSpan);
          const trackedEnd = Math.min(endColumn, occupiedUntil.length);
          for (let slot = column; slot < trackedEnd; slot++) {
            occupiedUntil[slot] = Math.max(occupiedUntil[slot]!, endRow);
          }
        }
        if (inBounds && index <= lastText) {
          if (column > lastColumn) yield "\t".repeat(column - lastColumn);
          yield CELL_START;
          yield* paragraphs(cell);
          yield { fallback: odfValue(cell) };
          yield CELL_END;
          lastColumn = column;
        }
        column = endColumn;
      }
      if (lastText >= 0) yield "\n";
    }
    if (rowGroup) occupiedUntil.fill(0);
  }
}

function* table(node: XmlNode): Generator<TextPart, void> {
  for (const caption of children(node)) {
    if (caption.name !== "caption") continue;
    yield LINE_START;
    yield* paragraphs(caption);
    yield LINE_START;
  }
  if (node.epubTable) {
    yield* epubTable(node);
    return;
  }
  let rowCount = 0;
  for (const row of all(node, ["tr", "table-row"], ["caption"])) {
    // Word nests a cell inside w:sdt when a content control wraps the whole cell.
    const cells = [...all(row, ["tc", "table-cell", "covered-table-cell", "td", "th"])];
    // ODS writers pad sheets with repeated empty rows and trailing cells.
    while (cells.length && !hasCellText(cells.at(-1)!)) cells.pop();
    if (!cells.length) continue;
    const repeat = repeatCount(row.attrs["number-rows-repeated"]);
    // Word emits no cells for the grid columns w:gridBefore skips at the start of a row.
    const trPr = row.name === "tr" ? children(row).find((c) => c.name === "trPr") : undefined;
    const before = trPr && children(trPr).find((c) => c.name === "gridBefore")?.attrs.val;
    const skipped = before ? Math.max(0, Number.parseInt(before, 10) || 0) : 0;
    for (let index = 0; index < repeat; index++) {
      if (++rowCount > 10_000) throw new Truncation("Row limit");
      let column = skipped;
      let gap = skipped;
      for (const cell of cells) {
        const count = repeatCount(cell.attrs["number-columns-repeated"]);
        // Word emits no cell for columns covered by w:gridSpan; pad before the next cell.
        const tcPr = cell.name === "tc" ? children(cell).find((c) => c.name === "tcPr") : undefined;
        const val = tcPr && children(tcPr).find((c) => c.name === "gridSpan")?.attrs.val;
        const span = val ? Math.max(1, Number.parseInt(val, 10) || 1) : 1;
        for (let i = 0; i < count; i++) {
          column += span;
          if (column > 512) throw new Truncation("Column limit");
          if (gap) yield "\t".repeat(gap);
          gap = span;
          // LibreOffice hides the contents a merge covers; the cell still holds its column.
          if (covered(cell)) continue;
          yield CELL_START;
          yield* paragraphs(cell);
          yield { fallback: odfValue(cell) };
          yield CELL_END;
        }
      }
      yield "\n";
    }
  }
}

async function archive(path: string): Promise<Map<string, string>> {
  const zip = await new Promise<Yauzl.ZipFile>((resolve, reject) =>
    Yauzl.open(
      path,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, result) => (error || !result ? reject(error) : resolve(result)),
    ),
  );
  const files = new Map<string, string>();
  let expanded = 0;
  let count = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Yauzl.Entry) => {
        if (++count > 2048 || zip.entryCount > 2048) {
          reject(new Truncation("Archive limit"));
          return;
        }
        if (entry.generalPurposeBitFlag & 1) {
          reject(new Error("Encrypted archive"));
          return;
        }
        if (!/\.(xml|rels|xhtml|html|htm|opf|svg)$/i.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        if (
          entry.uncompressedSize > MAX_EXPANDED ||
          entry.uncompressedSize > Math.max(1024, entry.compressedSize * 200)
        ) {
          reject(new Truncation("Archive limit"));
          return;
        }
        expanded += entry.uncompressedSize;
        if (expanded > MAX_EXPANDED) {
          reject(new Truncation("Expanded byte limit"));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error);
            return;
          }
          const buffers: Buffer[] = [];
          let size = 0;
          stream.on("error", reject);
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > entry.uncompressedSize || size > MAX_EXPANDED) {
              stream.destroy(new Truncation("Entry byte limit"));
              return;
            }
            buffers.push(chunk);
          });
          stream.on("end", () => {
            const data = Buffer.concat(buffers);
            // XML's BOM and initial '<' bytes distinguish both UTF-16 byte orders.
            const encoding =
              (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0x3c && data[1] === 0)
                ? "utf-16le"
                : (data[0] === 0xfe && data[1] === 0xff) || (data[0] === 0 && data[1] === 0x3c)
                  ? "utf-16be"
                  : "utf-8";
            files.set(entry.fileName, new TextDecoder(encoding).decode(data));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return files;
}

const NOTEBOOK_CELL_TYPES = ["code", "markdown", "raw"];

function* notebook(source: string): Generator<string, void> {
  const book: unknown = JSON.parse(source);
  if (!book || typeof book !== "object" || !("cells" in book) || !Array.isArray(book.cells))
    throw new Error("Invalid notebook");
  function* lines(value: unknown): Generator<string, void> {
    if (typeof value === "string") yield value;
    else if (Array.isArray(value))
      for (const line of value) {
        if (typeof line === "string") yield line;
      }
  }
  function outputText(value: unknown, stream = false): string {
    // Notebook fragments can split a terminal escape sequence or a CRLF pair.
    const plain = NodeUtil.stripVTControlCharacters([...lines(value)].join(""));
    return stream ? terminalOutputCollapseRedraws(plain) : plain;
  }
  for (const [index, cell] of book.cells.entries()) {
    if (index >= 10_000) throw new Truncation("Notebook cell limit");
    if (!cell || typeof cell !== "object") continue;
    const cellType = "cell_type" in cell ? cell.cell_type : undefined;
    const kind = NOTEBOOK_CELL_TYPES.find((type) => type === cellType) ?? "markdown";
    yield `## Cell ${index + 1} (${kind})\n`;
    if ("source" in cell) yield* lines(cell.source);
    if ("outputs" in cell && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      yield "\nOutput:\n";
      for (const output of cell.outputs) {
        if (!output || typeof output !== "object") continue;
        if ("text" in output)
          yield outputText(output.text, "output_type" in output && output.output_type === "stream");
        else if (
          "data" in output &&
          output.data &&
          typeof output.data === "object" &&
          ("text/plain" in output.data || "text/markdown" in output.data)
        ) {
          const plain = outputText(
            "text/plain" in output.data ? output.data["text/plain"] : undefined,
          );
          yield "text/markdown" in output.data && !plain.replaceAll("\0", "").trim()
            ? outputText(output.data["text/markdown"])
            : plain;
        } else if ("output_type" in output && output.output_type === "error") {
          if ("ename" in output) yield* lines(output.ename);
          if ("evalue" in output) {
            yield ": ";
            yield* lines(output.evalue);
          }
          yield "\n";
          if ("traceback" in output)
            for (const line of lines(output.traceback)) {
              yield NodeUtil.stripVTControlCharacters(line);
              yield "\n";
            }
        }
        yield "\n";
      }
    }
    yield "\n\n";
  }
}

const FONT_CODE_PAGES = new Map([
  [0, "windows-1252"],
  [77, "macintosh"],
  [128, "shift_jis"],
  [129, "euc-kr"],
  [134, "gbk"],
  [136, "big5"],
  [161, "windows-1253"],
  [162, "windows-1254"],
  [163, "windows-1258"],
  [177, "windows-1255"],
  [178, "windows-1256"],
  [186, "windows-1257"],
  [204, "windows-1251"],
  [222, "windows-874"],
  [238, "windows-1250"],
  [255, "ibm866"],
]);

const RTF_CODE_PAGES = new Map([
  [0, "windows-1252"],
  [866, "ibm866"],
  [874, "windows-874"],
  [932, "shift_jis"],
  [936, "gbk"],
  [949, "euc-kr"],
  [950, "big5"],
  [10000, "macintosh"],
  [54936, "gb18030"],
  [65001, "utf-8"],
]);

const rtfCodePage = (value: number) =>
  RTF_CODE_PAGES.get(value) ?? (value >= 1250 && value <= 1258 ? `windows-${value}` : undefined);

function* rtf(source: string): Generator<string, void> {
  if (!source.startsWith("{\\rtf")) throw new Error("Invalid RTF document");
  let state = {
    skip: false,
    deleted: false,
    hiddenText: false,
    uc: 1,
    font: 0,
    fontTable: false,
    fontFile: false,
    decoder: new TextDecoder("windows-1252"),
  };
  const stack: Array<typeof state> = [];
  // A font's \cpg, else its \fcharset, not the document code page, encodes the bytes written in
  // that font. A \cpg inside \fontfile encodes the font's file name instead.
  const fonts = new Map<number, typeof state.decoder>();
  let defaultFont = 0;
  const decoder = () => fonts.get(state.font) ?? state.decoder;
  const hidden = () => state.skip || state.deleted || state.hiddenText;
  let encoded: Uint8Array | undefined;
  let encodedLength = 0;
  function* flushBytes(): Generator<string, void> {
    if (!encodedLength) return;
    const chunk = encoded!.subarray(0, encodedLength);
    encodedLength = 0;
    yield decoder().decode(chunk);
  }
  function* emitByte(byte: number): Generator<string, void> {
    // No supported multibyte code page uses bytes below 0x30 as trail bytes.
    if ((!encodedLength && byte < 128) || (encodedLength && byte < 0x30)) {
      yield* flushBytes();
      yield String.fromCharCode(byte);
      return;
    }
    // GB18030 spends up to 4 bytes per UTF-16 unit, so a full buffer decodes past MAX_OUTPUT.
    encoded ??= new Uint8Array(Math.min(source.length, MAX_OUTPUT * 4 + 4));
    if (encodedLength === encoded.length) yield* flushBytes();
    encoded[encodedLength++] = byte;
  }
  const symbols = new Map([
    ["endash", "–"],
    ["emdash", characterEntities.mdash],
    ["enspace", "\u2002"],
    ["emspace", "\u2003"],
    ["qmspace", "\u2005"],
    ["lquote", "‘"],
    ["rquote", "’"],
    ["ldblquote", "“"],
    ["rdblquote", "”"],
    ["bullet", "•"],
    ["zwj", "\u200d"],
    ["zwnj", "\u200c"],
    ["ltrmark", "\u200e"],
    ["rtlmark", "\u200f"],
    ["~", "\u00a0"],
    ["_", "\u2011"],
    ["-", ""],
  ]);
  let fallback = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === "{" || char === "}") {
      yield* flushBytes();
      fallback = 0;
    }
    if (char === "{") {
      stack.push({ ...state });
      if (stack.length > 128) throw new Truncation("RTF depth limit");
    } else if (char === "}") state = stack.pop() ?? state;
    else if (char === "\\") {
      const rest = source.slice(i + 1, i + 80);
      const hex = /^'([0-9a-f]{2})/i.exec(rest);
      const word = /^([a-z]+)(-?\d+)? ?/i.exec(rest);
      if (hex) {
        if (fallback) fallback--;
        else if (!hidden()) yield* emitByte(Number.parseInt(hex[1]!, 16));
        i += 3;
      } else if (word) {
        i += word[0].length;
        const control = word[1]!;
        const value = Number(word[2]);
        if (control === "bin") {
          if (!Number.isSafeInteger(value) || value < 0)
            throw new Error("Invalid RTF binary length");
          i += value;
        }
        if (fallback) {
          fallback--;
          continue;
        }
        yield* flushBytes();
        if (
          [
            "fonttbl",
            "colortbl",
            "stylesheet",
            "info",
            "pict",
            "object",
            "fldinst",
            "header",
            "headerf",
            "headerl",
            "headerr",
            "footer",
            "footerf",
            "footerl",
            "footerr",
          ].includes(control)
        )
          state.skip = true;
        if (control === "fonttbl") state.fontTable = true;
        else if (control === "fontfile") state.fontFile = true;
        else if (control === "deff") state.font = defaultFont = value;
        else if (control === "f") {
          state.font = value;
          if (state.fontTable) fonts.delete(value);
        } else if (control === "fcharset" && state.fontTable) {
          const codePage = FONT_CODE_PAGES.get(value);
          if (value === 1) fonts.delete(state.font);
          else if (codePage) fonts.set(state.font, new TextDecoder(codePage));
        } else if (control === "cpg" && state.fontTable && !state.fontFile) {
          const codePage = rtfCodePage(value);
          if (codePage) fonts.set(state.font, new TextDecoder(codePage));
        }
        if (control === "deleted") state.deleted = value !== 0;
        else if (control === "v") state.hiddenText = value !== 0;
        else if (control === "plain") {
          state.deleted = false;
          state.hiddenText = false;
          state.font = defaultFont;
        }
        if (control === "mac") state.decoder = new TextDecoder("macintosh");
        else if (control === "ansicpg") {
          const label = rtfCodePage(value);
          if (!label) throw new Error("Unsupported RTF code page");
          state.decoder = new TextDecoder(label);
        } else if (control === "uc") {
          if (!Number.isSafeInteger(value) || value < 0)
            throw new Error("Invalid RTF fallback count");
          state.uc = value;
        } else if (control === "u") {
          if (!hidden()) yield String.fromCharCode(value < 0 ? value + 65536 : value);
          fallback = state.uc;
        } else if (!hidden() && ["par", "line", "sect", "page", "column"].includes(control))
          yield "\n";
        else if (!hidden() && control === "tab") yield "\t";
        // Table structure survives tracked deletions; only the deleted cell text is dropped.
        else if (!state.skip && control === "row") yield "\n";
        else if (!state.skip && control === "cell") yield "\t";
        else if (!hidden() && symbols.has(control)) yield symbols.get(control)!;
      } else {
        i++;
        if (fallback) fallback--;
        else if (!hidden() && ["\\", "{", "}"].includes(rest[0]!))
          yield* emitByte(rest[0]!.charCodeAt(0));
        else {
          yield* flushBytes();
          if (rest[0] === "*") state.skip = true;
          // A backslash before a line break is \par; TextEdit ends paragraphs this way.
          else if (!hidden() && (rest[0] === "\n" || rest[0] === "\r")) yield "\n";
          else if (!hidden() && symbols.has(rest[0]!)) yield symbols.get(rest[0]!)!;
        }
      }
    } else if (char !== "\n" && char !== "\r") {
      if (fallback) fallback--;
      else if (!hidden()) yield* emitByte(char.charCodeAt(0));
    }
  }
  yield* flushBytes();
}

async function* document(path: string, extension: string): AsyncGenerator<TextPart, void> {
  if ((await NodeFSP.stat(path)).size > MAX_INPUT) throw new Truncation("Input byte limit");
  if (extension === ".ipynb") yield* notebook(await NodeFSP.readFile(path, "utf8"));
  else if (extension === ".rtf") yield* rtf((await NodeFSP.readFile(path)).toString("latin1"));
  else {
    const files = await archive(path);
    // OPC part names compare case-insensitively for ASCII letters; exact names win.
    const foldAscii = (name: string) => name.replaceAll(/[A-Z]/gu, (char) => char.toLowerCase());
    const folded = new Map<string, string>();
    for (const name of files.keys())
      if (!folded.has(foldAscii(name))) folded.set(foldAscii(name), name);
    const part = (name: string) => (files.has(name) ? name : (folded.get(foldAscii(name)) ?? name));
    const has = (name: string) => files.has(part(name));
    const notes: string[] = [];
    const skip = (name: string) =>
      notes.push(`\n[Skipped document part: ${name} (missing or invalid XML).]\n`);
    const read = (name: string): XmlNode => {
      try {
        const data = files.get(part(name));
        if (!data) throw new Error("Missing document part");
        return xml(data, extension);
      } catch (error) {
        if (error instanceof Truncation) throw error;
        skip(name);
        return { name: "root", attrs: {}, children: [] };
      }
    };
    const partRels = (name: string) =>
      NodePath.posix.join(
        NodePath.posix.dirname(name),
        "_rels",
        `${NodePath.posix.basename(name)}.rels`,
      );
    const relations = (name: string) =>
      new Map(
        [...all(read(name), "Relationship")]
          .filter((rel) => rel.attrs.TargetMode !== "External")
          .map((rel) => [rel.attrs.Id, rel.attrs]),
      );
    // The package relationship names the main part; Word for the web saves word/document2.xml.
    const mainPart = (fallback: string) => {
      const target = has("_rels/.rels")
        ? [...all(read("_rels/.rels"), "Relationship")].find(
            (rel) =>
              rel.attrs.Type?.endsWith("/officeDocument") && rel.attrs.TargetMode !== "External",
          )?.attrs.Target
        : undefined;
      const main = target && NodePath.posix.normalize(target).replace(/^\//, "");
      return main && has(main) ? main : fallback;
    };
    if (extension === ".docx") {
      yield* paragraphs(read(mainPart("word/document.xml")));
    } else if ([".odt", ".ods", ".odp"].includes(extension)) {
      const content = read("content.xml");
      if (extension === ".odt")
        yield* paragraphs(
          children(children(content)[0]).find((child) => child.name === "body") ?? content,
        );
      else {
        let index = 0;
        for (const part of all(content, extension === ".ods" ? "table" : "page")) {
          yield extension === ".ods"
            ? `\n\n## Sheet: ${part.attrs.name ?? "Untitled"}\n`
            : `\n\n## Slide ${++index}\n`;
          if (extension === ".ods") {
            yield* table(part);
            continue;
          }
          const notes = children(part).find((child) => child.name === "notes");
          yield* paragraphs({
            ...part,
            children: part.children.filter((child) => child !== notes),
          });
          if (notes && hasCellText(notes)) {
            yield "\nNotes:\n";
            yield* paragraphs(notes);
          }
        }
      }
    } else if (extension === ".xlsx") {
      const workbookPath = mainPart("xl/workbook.xml");
      const workbookDir = NodePath.posix.dirname(workbookPath);
      const resolveWorkbookPart = (target: string) =>
        NodePath.posix.resolve(`/${workbookDir}`, target).slice(1);
      const workbook = read(workbookPath);
      const rels = relations(partRels(workbookPath));
      const workbookRelations = [...rels.values()];
      const workbookPartPath = (part: string) => {
        const target = workbookRelations.find((rel) => rel.Type?.endsWith(`/${part}`))?.Target;
        return resolveWorkbookPart(target || `${part}.xml`);
      };
      const dateSystem = ["1", "true"].includes(
        all(workbook, "workbookPr").next().value?.attrs.date1904 ?? "",
      )
        ? "1904"
        : "1900";
      const stylesPath = workbookPartPath("styles");
      const styles = has(stylesPath) ? read(stylesPath) : undefined;
      const customFormats = new Map(
        styles
          ? [...all(styles, "numFmt")].map((node) => [node.attrs.numFmtId, node.attrs.formatCode])
          : [],
      );
      const cellFormats = styles ? all(styles, "cellXfs").next().value : undefined;
      const formats = cellFormats ? children(cellFormats) : [];
      const sharedPath = workbookPartPath("sharedStrings");
      const strings = has(sharedPath) ? [...all(read(sharedPath), "si")] : [];
      const populatedStrings = strings.map(hasCellText);
      for (const sheet of all(workbook, "sheet")) {
        yield `\n## Sheet: ${sheet.attrs.name}\n`;
        const target = rels.get(sheet.attrs["r:id"] ?? sheet.attrs.id)?.Target;
        if (!target) {
          skip(`sheet relationship ${sheet.attrs.name}`);
          continue;
        }
        const name = resolveWorkbookPart(target);
        const populated = (cell: XmlNode) => {
          const value = all(cell, "v").next().value;
          if (cell.attrs.t === "s") {
            const raw = value?.children.find((child) => typeof child === "string")?.trim();
            return !!raw && !!populatedStrings[Number(raw)];
          }
          if (cell.attrs.t === "inlineStr") return hasCellText(cell);
          if (value && hasCellText(value)) return true;
          for (const formula of all(cell, "f")) if (hasCellText(formula)) return true;
          return false;
        };
        let rowCount = 0;
        for (const row of all(read(name), "row")) {
          const cells: Array<XmlNode | undefined> = [];
          let nextColumn = 0;
          let columnsTruncated = false;
          for (const cell of children(row).filter((node) => node.name === "c")) {
            const letters = cell.attrs.r?.match(/^[A-Z]+/)?.[0];
            const column = letters
              ? [...letters].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1
              : nextColumn;
            nextColumn = column + 1;
            if (!populated(cell)) continue;
            if (column >= 512) {
              columnsTruncated = true;
              continue;
            }
            cells[column] = cell;
          }
          if (!cells.length && !columnsTruncated) continue;
          if (++rowCount > 10_000) throw new Truncation("Row limit");
          for (const [column, cell] of cells.entries()) {
            if (column) yield "\t";
            if (!cell) continue;
            const value = all(cell, "v").next().value;
            const raw = value?.children.find((child) => typeof child === "string") ?? "";
            if (cell.attrs.t === "s") {
              const shared = strings[Number(raw)];
              if (shared) yield* inCell(xstringText(shared));
            } else if (cell.attrs.t === "inlineStr") yield* inCell(xstringText(cell));
            else if (cell.attrs.t === "b" && (raw.trim() === "0" || raw.trim() === "1"))
              yield* inCell([raw.trim() === "1" ? "true" : "false"]);
            else {
              if (value && hasCellText(value)) yield* inCell(xstringText(value));
              else for (const formula of all(cell, "f")) yield* inCell(text(formula));
              const formatId = formats[Number(cell.attrs.s ?? 0)]?.attrs.numFmtId;
              const format = formatId ? customFormats.get(formatId) : undefined;
              if (
                (cell.attrs.t === undefined || cell.attrs.t === "n") &&
                raw.trim() &&
                formatId &&
                formatId !== "0"
              )
                yield ` [Excel numFmtId=${formatId}${format ? `; format=${format}` : ""}; date system ${dateSystem}]`;
            }
          }
          yield "\n";
          if (columnsTruncated) throw new Truncation("Column limit");
        }
      }
    } else if (extension === ".pptx") {
      const presentationPath = mainPart("ppt/presentation.xml");
      const presentationDir = NodePath.posix.dirname(presentationPath);
      const rels = relations(partRels(presentationPath));
      const [presentation] = children(read(presentationPath));
      const slideList = children(presentation).find((node) => node.name === "sldIdLst");
      const inheritedAttributes = { ...presentation?.attrs, ...slideList?.attrs };
      let index = 0;
      for (const slide of children(slideList).filter((node) => node.name === "sldId")) {
        yield `\n\n## Slide ${++index}\n`;
        const target = rels.get(slideRelationshipId(slide, inheritedAttributes))?.Target;
        if (!target) {
          skip(`slide relationship ${index}`);
          continue;
        }
        const name = NodePath.posix.resolve(`/${presentationDir}`, target).slice(1);
        yield* paragraphs(read(name));
        const slideRels = partRels(name);
        if (!has(slideRels)) continue;
        for (const rel of all(read(slideRels), "Relationship")) {
          const target = rel.attrs.Target;
          if (
            !rel.attrs.Type?.endsWith("/notesSlide") ||
            rel.attrs.TargetMode === "External" ||
            !target
          )
            continue;
          const notesPage = withoutNotesPagePlaceholders(
            read(
              target.startsWith("/")
                ? target.slice(1)
                : NodePath.posix.join(NodePath.posix.dirname(name), target),
            ),
          );
          if (!hasCellText(notesPage)) continue;
          yield "Notes:\n";
          yield* paragraphs(notesPage);
        }
      }
    } else if (extension === ".epub") {
      let rootfile = all(read("META-INF/container.xml"), "rootfile").next().value?.attrs[
        "full-path"
      ];
      if (!rootfile) {
        if (!notes.length) skip("EPUB package");
        yield* notes;
        return;
      }
      try {
        const decoded = decodeURIComponent(rootfile);
        if (files.has(decoded)) rootfile = decoded;
      } catch {}
      const packageXml = read(rootfile);
      const items = new Map(
        [...all(packageXml, "item")].map((item) => [item.attrs.id, item.attrs.href]),
      );
      let index = 0;
      for (const item of all(packageXml, "itemref")) {
        yield `\n\n## Chapter ${++index}\n`;
        const href = items.get(item.attrs.idref);
        if (!href) {
          skip(`chapter ${index}`);
          continue;
        }
        let decoded: string;
        try {
          decoded = decodeURIComponent(href.split(/[?#]/, 1)[0]!);
        } catch {
          skip(`chapter ${index}`);
          continue;
        }
        const name = NodePath.posix.normalize(
          NodePath.posix.join(NodePath.posix.dirname(rootfile), decoded),
        );
        yield* paragraphs(read(name));
      }
    } else throw new Error("Unsupported document");
    yield* notes;
  }
}

// Undefined when the text holds only spaces and tabs, so the line state carries over.
function endsMidLine(text: string) {
  let index = text.length - 1;
  while (text[index] === " " || text[index] === "\t") index--;
  return index < 0 ? undefined : text[index] !== "\n";
}

export async function extractDocumentText(path: string, extension: string): Promise<string> {
  let result = "";
  let remaining = MAX_OUTPUT;
  let cellDepth = 0;
  let started = false;
  let space = false;
  let midLine = false;
  let pendingThematicBreak: string | undefined;
  let endsWithWord = false;
  let afterImageDescription = false;
  let truncated = false;
  try {
    // Charge raw text before normalization so repeated whitespace also exhausts the budget.
    for await (let part of document(path, extension)) {
      if (part === CELL_START) {
        if (cellDepth++ === 0) {
          started = false;
          space = false;
        } else if (started) space = true;
        continue;
      }
      if (part === CELL_END) {
        remaining -= pendingThematicBreak?.length ?? 0;
        pendingThematicBreak = undefined;
        cellDepth--;
        if (cellDepth > 0 && started) space = true;
        continue;
      }
      if (part === THEMATIC_BREAK) {
        if (midLine) pendingThematicBreak ??= "";
        continue;
      }
      if (part === LINE_START) {
        // A list starts its own line unless the text before it already ended one.
        if (!midLine) continue;
        part = "\n";
      }
      let raw: string;
      let isImageDescription = false;
      if (typeof part === "string") raw = part;
      else if ("imageDescription" in part) {
        raw = part.imageDescription;
        isImageDescription = true;
      } else {
        if (started) continue;
        raw = part.fallback;
      }
      if (pendingThematicBreak !== undefined) {
        const next = pendingThematicBreak + raw;
        const hasContent = /[^ \t]/u.test(raw);
        // Inline markup can split significant indentation across chunks.
        if (!hasContent && next.length < remaining) {
          pendingThematicBreak = next;
          continue;
        }
        raw = hasContent && !/^[ \t]*\n/u.test(raw) ? "\n" + next : next;
        pendingThematicBreak = undefined;
      }
      // Resolve image boundaries here, after inline markup has been flattened.
      // Pending cell whitespace has already used its share of the output budget.
      if (
        (isImageDescription || afterImageDescription) &&
        endsWithWord &&
        !(cellDepth > 0 && started && space) &&
        /^\u00ad*[\p{L}\p{M}\p{N}_]/u.test(raw)
      )
        raw = " " + raw;
      let value = raw.slice(0, remaining).replaceAll("\0", "");
      remaining -= Math.min(raw.length, remaining);
      if (cellDepth) {
        value = value.replaceAll(/\s+/g, " ");
        const trimmed = value.trim();
        if (trimmed) {
          const separator = started && (space || value.startsWith(" ")) ? " " : "";
          started = true;
          midLine = true;
          space = value.endsWith(" ");
          value = separator + trimmed;
        } else {
          space = value.endsWith(" ") || (!value && space);
          value = "";
        }
      } else {
        midLine = endsMidLine(value) ?? midLine;
      }
      result += value;
      if (extension === ".epub") {
        // Soft hyphens stay in the output but do not decide where a visible word ends.
        let end = value.length;
        while (value[end - 1] === "\u00ad") end--;
        if (end > 0) {
          endsWithWord = /[\p{L}\p{M}\p{N}_]$/u.test(value.slice(Math.max(0, end - 2), end));
          afterImageDescription = isImageDescription;
        }
      }
      if (remaining === 0) throw new Truncation("Output budget");
    }
  } catch (error) {
    if (!(error instanceof Truncation)) throw error;
    truncated = true;
  }
  result = result.replaceAll(/\n(?:[ \t]*\n){2,}/g, "\n\n").trim();
  if (!result && !truncated) throw new Error("No text extracted");
  return truncated ? result.replace(/[\uD800-\uDBFF]$/, "").trimEnd() + TRUNCATED : result;
}
