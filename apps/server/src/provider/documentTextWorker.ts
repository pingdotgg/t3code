// @effect-diagnostics nodeBuiltinImport:off -- isolated CLI worker; no server runtime is loaded here.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { characterEntities } from "character-entities";
import { SaxesParser } from "saxes";
import * as Yauzl from "yauzl";
import { notebookOutputGroups } from "@t3tools/shared/notebookOutput";
import { terminalOutputCollapseRedraws } from "@t3tools/shared/terminalOutput";

const MAX_INPUT = 16 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
const MAX_OUTPUT = 1_000_000;
const CELL_START = Symbol("cell-start");
const CELL_END = Symbol("cell-end");
const LINE_START = Symbol("line-start");
const THEMATIC_BREAK = Symbol("thematic-break");
const RTF_NOTE_START = Symbol("rtf-note-start");
const RTF_NOTE_END = Symbol("rtf-note-end");
const PRESENTATIONML_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/presentationml/2006/main",
  "http://purl.oclc.org/ooxml/presentationml/main",
]);
const WORDPROCESSINGML_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const WORD_DRAWING_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing",
]);
const WORD_STYLE_ELEMENTS = new Set([
  "styles",
  "docDefaults",
  "rPrDefault",
  "style",
  "basedOn",
  "p",
  "pPr",
  "pStyle",
  "rPr",
  "rStyle",
  "vanish",
]);
const WORD_STYLE_ATTRIBUTES = new Set(["val", "type", "styleId", "default"]);
const PPTX_DRAWING_PROPERTIES = new Map([
  ["sp", "nvSpPr"],
  ["grpSp", "nvGrpSpPr"],
  ["pic", "nvPicPr"],
  ["graphicFrame", "nvGraphicFramePr"],
  ["cxnSp", "nvCxnSpPr"],
]);
const MARKUP_COMPATIBILITY_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const SVG_NS = "http://www.w3.org/2000/svg";
const ODF_DRAW_NS = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0";
const ODF_STYLE_NS = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
const ODF_TEXT_NS = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const XML_SCHEMA_TRUE = /^[\t\n\r ]*(?:true|1)[\t\n\r ]*$/u;
type TextPart =
  | string
  | typeof CELL_START
  | typeof CELL_END
  | typeof LINE_START
  | typeof THEMATIC_BREAK
  | typeof RTF_NOTE_START
  | typeof RTF_NOTE_END
  | { columnGap: number }
  | { imageDescription: string }
  | { fallback: string }
  | { notebookOutput: Iterable<string> };

const NOTEBOOK_OUTPUT_HEADING = "\nOutput:\n";
const NOTEBOOK_OUTPUT_TEXT = /[^\s\0]/u;

const TRUNCATED = "\n\n[Extracted text truncated at document extraction limits.]";
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;
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
  pptxHidden?: boolean;
  docxHidden?: boolean;
  docxHiddenContent?: boolean;
  spaceCount?: number;
  wordOutlineHeadingLevel?: number;
  wordMergeCovered?: boolean;
  wordStyleAttrs?: Record<string, string>;
  hasText?: boolean;
  hasTextChoice?: boolean;
  markupCompatibility?: boolean;
  hasSelectedChoice?: boolean;
  epubTable?: boolean;
  mathmlFirstChildSeen?: boolean;
  epubBlock?: boolean;
  odfInlineParagraphs?: boolean;
  odfFloating?: boolean;
  odfParagraphHidden?: boolean;
  odfStyleHidden?: boolean;
  odfSpanHidden?: boolean;
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

function namespaceOf(tagName: string, scope: readonly XmlNode[]) {
  const colon = tagName.lastIndexOf(":");
  const binding = colon === -1 ? "xmlns" : `xmlns:${tagName.slice(0, colon)}`;
  return scope.findLast((node) => Object.hasOwn(node.attrs, binding))?.attrs[binding];
}

function odfAttribute(
  attributes: Record<string, string>,
  localName: string,
  scope: readonly XmlNode[],
  namespace = ODF_TEXT_NS,
) {
  return Object.entries(attributes).find(
    ([name]) => name.endsWith(`:${localName}`) && namespaceOf(name, scope) === namespace,
  )?.[1];
}

interface OdfTextStyle {
  parent: string | undefined;
  hidden: boolean | undefined;
  resolved?: boolean | undefined;
}

// ODF 1.3 Part 3 §19.510: parent-style-name names a common style, never an automatic one.
interface OdfStyleFamily {
  common: Map<string, OdfTextStyle>;
  automatic: Map<string, OdfTextStyle>;
}
type OdfTextStyles = Record<"text" | "paragraph", OdfStyleFamily>;

function odfTextStyleHidden(styles: OdfStyleFamily, name: string) {
  const automatic = styles.automatic.get(name);
  if (!automatic) return odfCommonTextStyleHidden(styles.common, name);
  if (automatic.hidden !== undefined) return automatic.hidden;
  return automatic.parent === undefined
    ? undefined
    : odfCommonTextStyleHidden(styles.common, automatic.parent);
}

function odfCommonTextStyleHidden(styles: Map<string, OdfTextStyle>, name: string) {
  let style = styles.get(name);
  if (!style || "resolved" in style) return style?.resolved;
  const visited = new Set<OdfTextStyle>();
  let hidden: boolean | undefined;
  while (style && !visited.has(style)) {
    if ("resolved" in style) {
      hidden = style.resolved;
      break;
    }
    visited.add(style);
    hidden = style.hidden;
    if (hidden !== undefined) break;
    style = style.parent === undefined ? undefined : styles.get(style.parent);
  }
  for (const visitedStyle of visited) visitedStyle.resolved = hidden;
  return hidden;
}

function isHiddenOdfField(attributes: Record<string, string>, scope: readonly XmlNode[]) {
  return XML_SCHEMA_TRUE.test(odfAttribute(attributes, "is-hidden", scope) ?? "");
}

function isHiddenOdfSection(
  tagName: string,
  attributes: Record<string, string>,
  scope: readonly XmlNode[],
) {
  return (
    namespaceOf(tagName, scope) === ODF_TEXT_NS &&
    Object.entries(attributes).some(
      ([name, value]) =>
        name.endsWith(":display") &&
        /^[\t\n\r ]*none[\t\n\r ]*$/u.test(value) &&
        namespaceOf(name, scope) === ODF_TEXT_NS,
    )
  );
}

function isXhtmlElement(
  tagName: string,
  scope: readonly XmlNode[],
  rootTagName: string | undefined,
) {
  const namespace = namespaceOf(tagName, scope);
  return (
    namespace === "http://www.w3.org/1999/xhtml" ||
    (namespace === undefined && !tagName.includes(":") && rootTagName === "html")
  );
}

function hasImportantDisplayNone(style: string): boolean {
  // Stylesheet rules can override non-important inline display.
  if (!style || style.includes("\\") || !/display/i.test(style) || !/important/i.test(style))
    return false;
  let badString = false;
  const declarations = style.replaceAll(
    /\/\*[\s\S]*?(?:\*\/|$)|"[^"]*(?:"|$)|'[^']*(?:'|$)/g,
    (token) => {
      if (token.startsWith("/")) return " ";
      // CSS ends a string at a newline, so later declarations can still apply.
      if (/[\n\r\f]/.test(token)) badString = true;
      return '""';
    },
  );
  // Semicolons in blocks can be part of a declaration's value.
  if (badString || /[()[\]{}]/.test(declarations)) return false;
  let hidden = false;
  for (const [declaration] of declarations.matchAll(/[^;]+/g)) {
    const match =
      /^[\t\n\f\r ]*(display|all)[\t\n\f\r ]*:([^!]+)![\t\n\f\r ]*important[\t\n\f\r ]*$/i.exec(
        declaration,
      );
    if (!match) continue;
    const [, property, value] = match;
    if (!value?.trim()) continue;
    hidden = property?.toLowerCase() === "display" && /^[\t\n\f\r ]*none[\t\n\f\r ]*$/i.test(value);
  }
  return hidden;
}

type WordStyleRunHidden = (id: string | undefined, ancestors: readonly XmlNode[]) => boolean;

function xml(
  source: string,
  extension: string,
  wordStyles?: WordStyleRunHidden | "definitions",
  odfTextStyles?: OdfTextStyles,
): XmlNode {
  const odf = [".odt", ".ods", ".odp"].includes(extension);
  const root: XmlNode = { name: "root", attrs: {}, children: [] };
  const stack = [root];
  const wordMergeTables = new WeakSet<XmlNode>();
  let rootTagName: string | undefined;
  let nodes = 0;
  const parser = new SaxesParser();
  if (extension === ".epub") Object.assign(parser.ENTITIES, characterEntities);
  parser.on("opentag", (tag) => {
    if (++nodes > 200_000 || stack.length > 128) throw new Truncation("XML structure limit");
    rootTagName ??= tag.name;
    const node: XmlNode = {
      name: tag.name.split(":").at(-1)!,
      attrs: Object.fromEntries(
        Object.entries(tag.attributes).flatMap(([key, value]) => {
          const local = key.split(":").at(-1)!;
          // A foreign attribute must not shadow an XHTML table span or a namespace declaration.
          return (extension === ".epub" &&
            (local === "colspan" || local === "rowspan" || local === "xmlns")) ||
            ((odf || extension === ".docx") && local === "xmlns")
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
    const parent = stack.at(-1)!;
    parent.children.push(node);
    stack.push(node);
    if (
      wordStyles !== undefined &&
      WORD_STYLE_ELEMENTS.has(node.name) &&
      WORDPROCESSINGML_NAMESPACES.has(namespaceOf(tag.name, stack) ?? "")
    ) {
      node.wordStyleAttrs = {};
      for (const [name, value] of Object.entries(tag.attributes)) {
        const colon = name.indexOf(":");
        const local = name.slice(colon + 1);
        if (
          colon !== -1 &&
          WORD_STYLE_ATTRIBUTES.has(local) &&
          WORDPROCESSINGML_NAMESPACES.has(namespaceOf(name, stack) ?? "")
        )
          node.wordStyleAttrs[local] = value;
      }
    }
    if (odfTextStyles) {
      if (parent.odfSpanHidden) node.odfSpanHidden = true;
      const styles = odfTextStyles[node.name === "span" ? "text" : "paragraph"];
      if (
        (node.name === "span" || node.name === "p" || node.name === "h") &&
        styles.common.size + styles.automatic.size > 0 &&
        namespaceOf(tag.name, stack) === ODF_TEXT_NS
      ) {
        const style = odfAttribute(tag.attributes, "style-name", stack);
        const hidden = style === undefined ? undefined : odfTextStyleHidden(styles, style);
        if (hidden !== undefined) node.odfSpanHidden = hidden;
      }
      if (
        node.name === "text-properties" &&
        parent.name === "style" &&
        namespaceOf(tag.name, stack) === ODF_STYLE_NS
      ) {
        const display = odfAttribute(tag.attributes, "display", stack)?.trim();
        if (display === "none" || display === "true") parent.odfStyleHidden = display === "none";
      }
    }
    if (odf && node.name === "text-box" && namespaceOf(tag.name, stack) === ODF_DRAW_NS)
      node.odfInlineParagraphs = true;
    const anchor =
      odf && namespaceOf(tag.name, stack) === ODF_DRAW_NS
        ? odfAttribute(tag.attributes, "anchor-type", stack)?.trim()
        : undefined;
    // Only a character-anchored drawing sits in the line; other anchors float beside the text.
    if (anchor === "as-char") node.odfInlineParagraphs = true;
    else if (anchor) node.odfFloating = true;
    if (
      extension === ".odt" &&
      node.name === "hidden-paragraph" &&
      namespaceOf(tag.name, stack) === ODF_TEXT_NS
    ) {
      const paragraph = stack.findLast(
        (ancestor) => ancestor.name === "p" || ancestor.name === "h",
      );
      // A visible field keeps the paragraph visible even if another field hides it.
      if (paragraph && paragraph.odfParagraphHidden !== false) {
        paragraph.odfParagraphHidden = isHiddenOdfField(tag.attributes, stack);
      }
    }
    if (
      extension === ".epub" &&
      node.name === "semantics" &&
      namespaceOf(tag.name, stack) === MATHML_NS
    )
      node.mathmlFirstChildSeen = false;
    if (
      extension === ".epub" &&
      ["nav", "main", "details", "summary", "center"].includes(node.name) &&
      isXhtmlElement(tag.name, stack, rootTagName)
    )
      node.epubBlock = true;
    if (
      (node.name === "AlternateContent" || node.name === "Choice") &&
      namespaceOf(tag.name, stack) === MARKUP_COMPATIBILITY_NS
    )
      node.markupCompatibility = true;
  });
  parser.on("closetag", (tag) => {
    const node = stack.pop()!;
    const parent = stack.at(-1)!;
    if (extension === ".docx" && node.name === "vMerge" && parent.name === "tcPr") {
      const table = stack.findLast((ancestor) => ancestor.name === "tbl");
      if (table) wordMergeTables.add(table);
    }
    if (wordMergeTables.has(node)) markWordMergeContinuations(node);
    if (
      odfTextStyles &&
      node.name === "style" &&
      (parent.name === "styles" || parent.name === "automatic-styles")
    ) {
      const scope = [...stack, node];
      const family = odfAttribute(tag.attributes, "family", scope, ODF_STYLE_NS);
      if (
        namespaceOf(tag.name, scope) === ODF_STYLE_NS &&
        (family === "text" || family === "paragraph")
      ) {
        const name = odfAttribute(tag.attributes, "name", scope, ODF_STYLE_NS);
        if (name !== undefined) {
          odfTextStyles[family][parent.name === "styles" ? "common" : "automatic"].set(name, {
            parent: odfAttribute(tag.attributes, "parent-style-name", scope, ODF_STYLE_NS),
            hidden: node.odfStyleHidden,
          });
        }
      }
    }
    const isOdfHiddenText =
      extension === ".odt" &&
      node.name === "hidden-text" &&
      namespaceOf(tag.name, [...stack, node]) === ODF_TEXT_NS;
    if (extension === ".pptx" && node.name === "cNvPr") {
      const hidden = tag.attributes.hidden?.trim();
      const drawing = stack.at(-2);
      if (
        drawing &&
        (hidden === "true" || hidden === "1") &&
        PPTX_DRAWING_PROPERTIES.get(drawing.name) === parent.name &&
        PRESENTATIONML_NAMESPACES.has(namespaceOf(tag.name, [...stack, node]) ?? "")
      ) {
        drawing.pptxHidden = true;
      }
    }
    if (
      extension === ".docx" &&
      node.name === "docPr" &&
      (parent.name === "anchor" || parent.name === "inline") &&
      ["true", "1"].includes(tag.attributes.hidden?.trim() ?? "") &&
      WORD_DRAWING_NAMESPACES.has(namespaceOf(tag.name, [...stack, node]) ?? "")
    ) {
      parent.docxHidden = true;
    }
    if (extension === ".docx" && node.name === "outlineLvl" && parent.name === "pPr") {
      const owner = stack.at(-2);
      const outline = Number(node.attrs.val?.match(/^\s*[+-]?\d+\s*$/u)?.[0]);
      if ((owner?.name === "p" || owner?.name === "style") && outline >= 0 && outline <= 9) {
        // Word's outline is zero-based, with 9 reserved for body text.
        owner.wordOutlineHeadingLevel = outline === 9 ? 0 : outline + 1;
      }
    }
    // MathML Core displays only the first element child of semantics by default.
    const isMathmlAlternative = parent.mathmlFirstChildSeen === true;
    if (parent.mathmlFirstChildSeen === false) parent.mathmlFirstChildSeen = true;
    let wordRunHidden = false;
    if (extension === ".docx" && node.name === "r") {
      const properties = children(node).flatMap((child) =>
        child.name === "rPr" ? children(child) : [],
      );
      const direct = wordVanish(properties.find((property) => property.name === "vanish")?.attrs);
      wordRunHidden =
        direct ??
        (typeof wordStyles === "function" &&
          WORDPROCESSINGML_NAMESPACES.has(namespaceOf(tag.name, [...stack, node]) ?? "") &&
          wordStyles(
            wordStyleChild(wordStyleChild(node, "rPr"), "rStyle")?.wordStyleAttrs?.val,
            stack,
          ));
    }
    const isCompatibilityChoice =
      node.name === "Choice" &&
      node.markupCompatibility &&
      parent.name === "AlternateContent" &&
      parent.markupCompatibility;
    if (odf && (node.name === "p" || node.name === "h")) collapseOdfWhitespace(node);
    // Keep compatibility fallbacks suppressed when a hidden drawing is omitted from a branch.
    if (node.docxHidden) parent.docxHiddenContent = true;
    // Hidden spans may contain a nested style that explicitly makes its text visible.
    if (
      node.pptxHidden ||
      node.docxHidden ||
      (node.odfSpanHidden && node.children.length === 0) ||
      (node.odfParagraphHidden && namespaceOf(tag.name, [...stack, node]) === ODF_TEXT_NS) ||
      isMathmlAlternative ||
      (extension === ".epub" &&
        node.name === "template" &&
        isXhtmlElement(tag.name, [...stack, node], rootTagName)) ||
      (extension === ".epub" &&
        node.name === "metadata" &&
        namespaceOf(tag.name, [...stack, node]) === SVG_NS) ||
      (extension === ".epub" &&
        (stack[1] ?? node).name === "html" &&
        ((Object.hasOwn(tag.attributes, "hidden") &&
          !/^until-found$/i.test(String(tag.attributes.hidden))) ||
          hasImportantDisplayNone(tag.attributes.style ?? ""))) ||
      (extension === ".docx" && node.name === "del") ||
      wordRunHidden ||
      (odf && node.name === "annotation" && parent.name !== "semantics") ||
      (isOdfHiddenText && isHiddenOdfField(tag.attributes, [...stack, node])) ||
      (extension === ".odt" &&
        node.name === "section" &&
        isHiddenOdfSection(tag.name, tag.attributes, [...stack, node])) ||
      (extension === ".pptx" &&
        node.name === "timing" &&
        stack.every((ancestor) =>
          ["root", "sld", "AlternateContent", "Choice", "Fallback"].includes(ancestor.name),
        )) ||
      (extension === ".odp" &&
        node.name === "page-thumbnail" &&
        stack.some((ancestor) => ancestor.name === "notes")) ||
      // Calc anchors floating shapes inside cells; their text is not cell data.
      (extension === ".ods" &&
        parent.name === "table-cell" &&
        namespaceOf(tag.name, [...stack, node]) === ODF_DRAW_NS) ||
      (isCompatibilityChoice && parent.hasSelectedChoice)
    ) {
      parent.children.pop();
      return;
    }
    if (
      extension === ".docx" &&
      node.name === "ruby" &&
      WORDPROCESSINGML_NAMESPACES.has(namespaceOf(tag.name, [...stack, node]) ?? "")
    ) {
      const base = children(node).find((child) => child.name === "rubyBase");
      const reading = children(node).find((child) => child.name === "rt");
      // Word stores the guide first even though the base is the text on the line.
      if (base?.hasText && reading?.hasText) node.children = [base, "(", reading, ")"];
    }
    if (
      extension === ".odt" &&
      node.name === "note" &&
      namespaceOf(tag.name, [...stack, node]) === ODF_TEXT_NS
    ) {
      const parts = children(node);
      const citation = parts.find((child) => child.name === "note-citation");
      const body = parts.find((child) => child.name === "note-body");
      if (citation?.hasText && body?.hasText) {
        body.odfInlineParagraphs = true;
        node.children = ["[", citation, ": ", body, "]"];
      }
    }
    if (isOdfHiddenText && !node.odfSpanHidden) {
      // ODF stores the visible field value in text:string-value when present.
      const value = odfAttribute(tag.attributes, "string-value", [...stack, node]);
      if (value !== undefined) {
        node.children = [value];
        node.hasText = value.trim() !== "";
      }
    }
    if (odf && node.name === "ruby" && namespaceOf(tag.name, [...stack, node]) === ODF_TEXT_NS) {
      const base = children(node).find((child) => child.name === "ruby-base");
      const reading = children(node).find((child) => child.name === "ruby-text");
      if (base?.hasText && reading?.hasText) node.children = [base, "(", reading, ")"];
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
    const hasContent = node.hasText || node.name === "noBreakHyphen";
    if (HIDDEN.has(node.name) || (!hasContent && !node.docxHiddenContent)) return;
    if (hasContent) parent.hasText = true;
    if (node.docxHiddenContent) parent.docxHiddenContent = true;
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
    if (node.odfSpanHidden) return;
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

function childNamed(node: XmlNode | undefined, name: string) {
  return node?.children.find(
    (child): child is XmlNode => typeof child !== "string" && child.name === name,
  );
}

function wordStyleChild(node: XmlNode | undefined, name: string) {
  return node?.children.find(
    (child): child is XmlNode =>
      typeof child !== "string" && child.name === name && child.wordStyleAttrs !== undefined,
  );
}

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
  // Word text boxes and floating ODF drawings hold their own paragraphs inside the anchoring one.
  if (node.name === "txbxContent" || node.odfFloating) yield* paragraphs(node);
  else if (node.odfInlineParagraphs) {
    // ODF boxes and notes can sit inline, so only add breaks between their own paragraphs.
    let seenParagraph = false;
    for (const child of node.children) {
      if (typeof child === "string") {
        yield child;
        continue;
      }
      if (child.name === "p" || child.name === "h") {
        if (seenParagraph) yield "\n";
        seenParagraph = true;
      }
      yield* text(child);
    }
  } else if (["tab", "ptab", "cell"].includes(node.name)) yield "\t";
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
// SpreadsheetML sheet names and cell strings are ST_Xstring: `_xHHHH_` is one UTF-16 code unit, and an
// escaped lead underscore (`_x005F_xHHHH_`) keeps the literal `_xHHHH_`. Decoded in one pass.
function decodeXstring(value: string): string {
  return value.replaceAll(
    /_x005[Ff]_(x[\dA-Fa-f]{4}_)|_x([\dA-Fa-f]{4})_/g,
    (_, literal?: string, hex?: string) =>
      literal ? `_${literal}` : String.fromCharCode(Number.parseInt(hex!, 16)),
  );
}

function* xstringText(node: XmlNode): Generator<string, void> {
  if (HIDDEN.has(node.name)) return;
  if (node.name !== "t" && node.name !== "v") {
    for (const child of children(node)) yield* xstringText(child);
    return;
  }
  yield decodeXstring(node.children.filter((child) => typeof child === "string").join(""));
}

function hasXstringText(node: XmlNode): boolean {
  for (const value of xstringText(node)) if (value.trim()) return true;
  return false;
}

function wordStyleOutlineLevel(
  outlines: Map<string, number | string | undefined>,
  id: string,
): number | undefined {
  let outline = outlines.get(id);
  if (typeof outline !== "string") return outline;
  const visited = new Set<string>();
  while (typeof outline === "string" && !visited.has(id)) {
    visited.add(id);
    id = outline;
    outline = outlines.get(id);
  }
  const level = typeof outline === "number" ? outline : undefined;
  for (const styleId of visited) outlines.set(styleId, level);
  return level;
}

type WordStyleToggle = {
  vanish: boolean | undefined;
  basedOn: string | undefined;
  toggled?: boolean | undefined;
};

// Each true vanish along a basedOn chain toggles the inherited state. A false value or a
// cycle leaves the outcome uncertain, so the caller keeps the text. Results are cached on
// every style of the chain so long chains resolve once.
function wordStyleToggled(styles: Map<string, WordStyleToggle>, id: string): boolean | undefined {
  const chain = new Set<WordStyleToggle>();
  let toggled: boolean | undefined = false;
  for (let current: string | undefined = id; current !== undefined;) {
    const style = styles.get(current);
    if (!style) break;
    if ("toggled" in style) {
      toggled = style.toggled;
      break;
    }
    if (chain.has(style) || style.vanish === false) {
      toggled = undefined;
      chain.add(style);
      break;
    }
    chain.add(style);
    current = style.basedOn;
  }
  for (const style of [...chain].toReversed()) {
    if (toggled !== undefined && style.vanish) toggled = !toggled;
    style.toggled = toggled;
  }
  return toggled;
}

function wordVanish(attrs: XmlNode["attrs"] | undefined): boolean | undefined {
  if (!attrs) return;
  const value = attrs.val?.trim() ?? "true";
  if (["true", "1", "on"].includes(value)) return true;
  if (["false", "0", "off"].includes(value)) return false;
}

function wordStyleVisibility(styles: XmlNode): WordStyleRunHidden | undefined {
  const definitions = wordStyleChild(styles, "styles");
  const runDefaults = wordStyleChild(wordStyleChild(definitions, "docDefaults"), "rPrDefault");
  if (wordVanish(wordStyleChild(wordStyleChild(runDefaults, "rPr"), "vanish")?.wordStyleAttrs))
    return;
  const character = new Map<string, WordStyleToggle>();
  const paragraph = new Map<string, WordStyleToggle>();
  let defaultParagraph: string | undefined;
  let tableCanToggle = false;
  for (const style of children(definitions)) {
    if (style.name !== "style" || !style.wordStyleAttrs?.styleId) continue;
    const { styleId, type } = style.wordStyleAttrs;
    if (type === "table") {
      tableCanToggle ||= [...all(style, "vanish", ["rPrChange"])].some((node) =>
        wordVanish(node.wordStyleAttrs),
      );
      continue;
    }
    const defined = {
      vanish: wordVanish(wordStyleChild(wordStyleChild(style, "rPr"), "vanish")?.wordStyleAttrs),
      basedOn: wordStyleChild(style, "basedOn")?.wordStyleAttrs?.val,
    };
    if (type === "character") character.set(styleId, defined);
    else if ((type ?? "paragraph") === "paragraph") {
      paragraph.set(styleId, defined);
      if (["true", "1", "on"].includes(style.wordStyleAttrs.default ?? ""))
        defaultParagraph = styleId;
    }
  }
  const paragraphCanToggle = [...paragraph.values()].some((style) => style.vanish);
  if (!paragraphCanToggle && ![...character.values()].some((style) => style.vanish)) return;
  // pPr precedes a paragraph's runs, so the first run settles its style for the rest.
  const paragraphStyles = new WeakMap<XmlNode, string | undefined>();
  return (id, ancestors) => {
    const characterToggles = id === undefined ? false : wordStyleToggled(character, id);
    if (characterToggles === undefined || (!characterToggles && !paragraphCanToggle)) return false;
    // Table styles also toggle; leave those combinations to the editor.
    if (tableCanToggle && ancestors.some((ancestor) => ancestor.name === "tbl")) return false;
    const owner = ancestors.findLast(
      (ancestor) => ancestor.name === "p" && ancestor.wordStyleAttrs,
    );
    let paragraphId = owner && paragraphStyles.get(owner);
    if (!owner || !paragraphStyles.has(owner)) {
      const named = wordStyleChild(wordStyleChild(owner, "pPr"), "pStyle")?.wordStyleAttrs?.val;
      paragraphId = named && paragraph.has(named) ? named : defaultParagraph;
      if (owner) paragraphStyles.set(owner, paragraphId);
    }
    const paragraphToggles =
      paragraphId === undefined ? false : wordStyleToggled(paragraph, paragraphId);
    return paragraphToggles !== undefined && paragraphToggles !== characterToggles;
  };
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
      const style = all(child, "pStyle", ["pPrChange", "txbxContent"]).next().value;
      const level =
        child.name === "h"
          ? Number(child.attrs["outline-level"]) || 1
          : /^h[1-6]$/.test(child.name)
            ? Number(child.name[1])
            : (child.wordOutlineHeadingLevel ??
              style?.wordOutlineHeadingLevel ??
              (Number(style?.attrs.val?.match(/^Heading([1-6])$/i)?.[1]) || 0));
      if (level) yield `${"#".repeat(Math.min(6, level))} `;
      yield* text(child);
      yield "\n";
    } else if (
      child.hasText &&
      (child.epubBlock ||
        [
          "blockquote",
          "figure",
          "figcaption",
          "aside",
          "address",
          "header",
          "footer",
          "article",
        ].includes(child.name))
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
  const count = Number(value);
  if (!/^[ \t\r\n]*\+?[0-9]+[ \t\r\n]*$/.test(value) || count < 1)
    throw new Error("Invalid repeat count");
  return count;
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
function wordSkippedColumns(row: XmlNode) {
  const before = childNamed(childNamed(row, "trPr"), "gridBefore")?.attrs.val;
  return before ? Math.max(0, Number.parseInt(before, 10) || 0) : 0;
}

function wordColumnSpan(properties: XmlNode | undefined) {
  const span = childNamed(properties, "gridSpan")?.attrs.val;
  return span ? Math.max(1, Number.parseInt(span, 10) || 1) : 1;
}

function markWordMergeContinuations(table: XmlNode) {
  let previous = new Map<number, number>();
  let current = new Map<number, number>();
  // Empty cells and rows still participate in the Word table grid.
  for (const row of all(table, "tr")) {
    let column = wordSkippedColumns(row);
    for (const cell of all(row, "tc")) {
      const properties = childNamed(cell, "tcPr");
      const span = wordColumnSpan(properties);
      const merge = childNamed(properties, "vMerge");
      if (merge) {
        const value = merge.attrs.val?.trim() ?? "continue";
        if (value === "continue" && previous.get(column) === span) cell.wordMergeCovered = true;
        if (value === "restart" || cell.wordMergeCovered) current.set(column, span);
      }
      column += span;
    }
    previous.clear();
    [previous, current] = [current, previous];
  }
}

// PowerPoint keeps the cells a merge covers and flags them with hMerge or vMerge.
const drawingMergeCovered = (cell: XmlNode) =>
  cell.name === "tc" &&
  [cell.attrs.hMerge, cell.attrs.vMerge].some((flag) => XML_SCHEMA_TRUE.test(flag ?? ""));
const covered = (cell: XmlNode) =>
  cell.name === "covered-table-cell" || cell.wordMergeCovered || drawingMergeCovered(cell);
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

function* epubTableParts(node: XmlNode) {
  // Legacy XHTML places footers before the body. The table model reads them after the other rows.
  const footers: XmlNode[] = [];
  for (const part of node.children) {
    if (typeof part === "string") continue;
    if (part.name === "tfoot") footers.push(part);
    else yield part;
  }
  yield* footers;
}

function* epubTable(node: XmlNode): Generator<TextPart, void> {
  const occupiedUntil = new Uint32Array(512);
  let rowIndex = 0;
  let rowCount = 0;
  for (const part of epubTableParts(node)) {
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
    const skipped = row.name === "tr" ? wordSkippedColumns(row) : 0;
    for (let index = 0; index < repeat; index++) {
      if (++rowCount > 10_000) throw new Truncation("Row limit");
      let column = skipped;
      let gap = skipped;
      for (const cell of cells) {
        const count = repeatCount(cell.attrs["number-columns-repeated"]);
        // Word emits no cell for columns covered by w:gridSpan; pad before the next cell.
        const span = cell.name === "tc" ? wordColumnSpan(childNamed(cell, "tcPr")) : 1;
        for (let i = 0; i < count; i++) {
          column += span;
          if (column > 512) throw new Truncation("Column limit");
          if (gap) yield { columnGap: gap };
          gap = span;
          // A merge hides the covered contents while preserving grid columns.
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

function* notebook(source: string): Generator<TextPart, void> {
  const book: unknown = JSON.parse(source.replace(/^\uFEFF/u, ""));
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
  function* cellOutputParts(outputs: readonly unknown[]): Generator<string, void> {
    for (const group of notebookOutputGroups(outputs, (value) => [...lines(value)].join(""))) {
      if (group.kind === "stream") {
        yield outputText(group.text, true);
        yield "\n";
        continue;
      }
      const output = group.output;
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
        yield "text/markdown" in output.data && !NOTEBOOK_OUTPUT_TEXT.test(plain)
          ? outputText(output.data["text/markdown"])
          : plain;
      } else if ("output_type" in output && output.output_type === "error") {
        const name = outputText("ename" in output ? output.ename : undefined);
        const value = outputText("evalue" in output ? output.evalue : undefined);
        if (NOTEBOOK_OUTPUT_TEXT.test(name + value)) {
          yield name;
          if ("evalue" in output) yield ": " + value;
        } else yield name + value;
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
  for (const [index, cell] of book.cells.entries()) {
    if (index >= 10_000) throw new Truncation("Notebook cell limit");
    if (!cell || typeof cell !== "object") continue;
    const cellType = "cell_type" in cell ? cell.cell_type : undefined;
    const kind = NOTEBOOK_CELL_TYPES.find((type) => type === cellType) ?? "markdown";
    yield `## Cell ${index + 1} (${kind})\n`;
    if ("source" in cell) yield* lines(cell.source);
    if ("outputs" in cell && Array.isArray(cell.outputs)) {
      yield { notebookOutput: cellOutputParts(cell.outputs) };
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

const MAX_RTF_DEPTH = 128;

function rtfGroupEnd(source: string, start: number, outerDepth: number) {
  // Match group boundaries without counting escaped braces or braces in binary data.
  const structure = /[{}]|\\(?:(bin)(?![a-z])(-?\d+)? ?|[\\{}])/gi;
  structure.lastIndex = start;
  let depth = outerDepth + 1;
  let token: RegExpExecArray | null;
  while (depth <= MAX_RTF_DEPTH && (token = structure.exec(source))) {
    if (token[0] === "{") depth++;
    else if (token[0] === "}") {
      if (--depth === outerDepth) return structure.lastIndex;
    } else if (token[1] === "bin") {
      const size = Number(token[2]);
      if (!Number.isSafeInteger(size) || size < 0) return;
      structure.lastIndex += size;
    }
  }
}

function rtfUnicodeDestination(
  source: string,
  start: number,
  outerDepth: number,
  verifiedThrough: number,
) {
  const ansiStart = /[\r\n]*\{/y;
  ansiStart.lastIndex = start;
  if (!ansiStart.test(source)) return;
  const ansiEnd = rtfGroupEnd(source, ansiStart.lastIndex, outerDepth);
  if (ansiEnd === undefined) return;

  const unicodeStart = /[\r\n]*\{[\r\n]*\\\*[\r\n]*\\ud(?![a-zA-Z]|-?\d) ?/y;
  unicodeStart.lastIndex = ansiEnd;
  if (!unicodeStart.test(source)) return;
  const body = unicodeStart.lastIndex;
  // An enclosing group already checked for balance also proves its nested groups close.
  const end = body < verifiedThrough ? verifiedThrough : rtfGroupEnd(source, body, outerDepth);
  if (end !== undefined) return { body, end };
}

const RTF_NESTED_CELL_END = Symbol("rtf-nested-cell-end");

function* rtf(source: string): Generator<TextPart, void> {
  // \nestcell ends a nested cell without a delimiter; space it only from adjacent text.
  let last = "";
  let afterNestedCell = false;
  for (const part of rtfParts(source)) {
    if (part === RTF_NESTED_CELL_END) {
      afterNestedCell = true;
      continue;
    }
    if (typeof part !== "string") {
      yield part;
      continue;
    }
    const text = part.replaceAll("\0", "");
    if (text) {
      if (afterNestedCell && /\S/u.test(last) && /\S/u.test(text[0]!)) yield " ";
      afterNestedCell = false;
      last = text.at(-1)!;
    }
    yield part;
  }
}

function* rtfParts(
  source: string,
): Generator<
  string | typeof RTF_NESTED_CELL_END | typeof RTF_NOTE_START | typeof RTF_NOTE_END,
  void
> {
  if (!source.startsWith("{\\rtf")) throw new Error("Invalid RTF document");
  let state = {
    skip: false,
    deleted: false,
    hiddenText: false,
    inTable: false,
    uc: 1,
    font: 0,
    fontTable: false,
    fontFile: false,
    decoder: new TextDecoder("windows-1252"),
  };
  const stack: Array<typeof state> = [];
  const openGroup = () => {
    stack.push({ ...state });
    if (stack.length > MAX_RTF_DEPTH) throw new Truncation("RTF depth limit");
  };
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
  let verifiedThrough = 0;
  const footnoteStart = /[\r\n]*(?:\\\*[\r\n]*)?\\footnote(?![a-zA-Z]|-?\d) ?/y;
  let footnoteDepth: number | undefined;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === "{" || char === "}") {
      yield* flushBytes();
      fallback = 0;
    }
    if (char === "{") {
      openGroup();
      footnoteStart.lastIndex = i + 1;
      if (footnoteStart.test(source)) {
        i = footnoteStart.lastIndex - 1;
        if (hidden() || footnoteDepth !== undefined) state.skip = true;
        else {
          footnoteDepth = stack.length;
          yield RTF_NOTE_START;
        }
      }
    } else if (char === "}") {
      if (footnoteDepth === stack.length) {
        footnoteDepth = undefined;
        yield RTF_NOTE_END;
      }
      state = stack.pop() ?? state;
    } else if (char === "\\") {
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
        if (control === "upr") {
          const unicode = rtfUnicodeDestination(source, i + 1, stack.length, verifiedThrough);
          if (unicode) {
            openGroup();
            verifiedThrough = unicode.end;
            i = unicode.body - 1;
          }
          continue;
        }
        if (
          [
            "fonttbl",
            "colortbl",
            "stylesheet",
            "info",
            "pict",
            "object",
            "fldinst",
            // Shape properties, and the drawing that repeats a shape for older readers.
            "sp",
            "shprslt",
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
        // \intbl is a paragraph property, so it lasts until \pard resets the paragraph.
        if (control === "intbl") state.inTable = true;
        else if (control === "pard") state.inTable = false;
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
          // A cell's paragraphs share its column, as in DOCX and ODT tables.
          yield state.inTable && (control === "par" || control === "line") ? " " : "\n";
        else if (!hidden() && control === "tab") yield "\t";
        // Table structure survives tracked deletions; only the deleted cell text is dropped.
        else if (!state.skip && control === "row") yield "\n";
        else if (!state.skip && control === "cell") yield "\t";
        else if (!state.skip && control === "nestcell") yield RTF_NESTED_CELL_END;
        else if (!hidden() && symbols.has(control)) yield symbols.get(control)!;
      } else {
        i++;
        if (fallback) fallback--;
        else if (!hidden() && ["\\", "{", "}"].includes(rest[0]!))
          yield* emitByte(rest[0]!.charCodeAt(0));
        else {
          yield* flushBytes();
          // Shape instructions are an optional destination, but a text box keeps its text there.
          if (rest[0] === "*" && !/^\*[\r\n]*\\shpinst(?![a-z])/i.test(rest)) state.skip = true;
          // A backslash before a line break is \par; TextEdit ends paragraphs this way.
          else if (!hidden() && (rest[0] === "\n" || rest[0] === "\r"))
            yield state.inTable ? " " : "\n";
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
    const read = (
      name: string,
      wordStyles?: WordStyleRunHidden | "definitions",
      odfTextStyles?: OdfTextStyles,
    ): XmlNode => {
      try {
        const data = files.get(part(name));
        if (!data) throw new Error("Missing document part");
        return xml(data, extension, wordStyles, odfTextStyles);
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
      const main = mainPart("word/document.xml");
      const rels = partRels(main);
      const mainRelations = has(rels) ? [...all(read(rels), "Relationship")] : [];
      const relationTarget = (type: string) =>
        mainRelations.find(
          (rel) => rel.attrs.Type?.endsWith(`/${type}`) && rel.attrs.TargetMode !== "External",
        )?.attrs.Target;
      const dir = `/${NodePath.posix.dirname(main)}`;
      const stylesPath = NodePath.posix
        .resolve(dir, relationTarget("styles") || "styles.xml")
        .slice(1);
      const styles = has(stylesPath) ? read(stylesPath, "definitions") : undefined;
      const styleRunHidden = styles && wordStyleVisibility(styles);
      const doc = read(main, styleRunHidden);
      // Footnotes and endnotes live in their own parts; put each inline where it is referenced.
      for (const kind of ["footnote", "endnote"]) {
        const noteTarget = relationTarget(`${kind}s`);
        const notePath = noteTarget && NodePath.posix.resolve(dir, noteTarget).slice(1);
        if (!notePath || !has(notePath)) continue;
        const bodies = new Map<string, string>();
        for (const note of all(read(notePath, styleRunHidden), kind)) {
          const body = Array.from(all(note, "p"), (paragraph) =>
            [...text(paragraph)].filter((part) => typeof part === "string").join(""),
          )
            .join("\n")
            .trim();
          if (note.attrs.id !== undefined && body) bodies.set(note.attrs.id, body);
        }
        for (const reference of all(doc, `${kind}Reference`)) {
          const body = bodies.get(reference.attrs.id ?? "");
          if (body) reference.children = [`[Note: ${body}]`];
        }
      }
      if (styles) {
        const outlines = new Map<string, number | string | undefined>();
        const headings = new Map<string, string>();
        for (const style of all(styles, "style")) {
          const id = style.attrs.styleId;
          if ((style.attrs.type ?? "paragraph") !== "paragraph" || !id) continue;
          const properties = children(style);
          const outline =
            style.wordOutlineHeadingLevel ??
            properties.find((c) => c.name === "basedOn")?.attrs.val;
          if (outline !== undefined) outlines.set(id, outline);
          // Word localizes style ids while keeping built-in English names.
          const name = properties.find((c) => c.name === "name")?.attrs.val;
          const level = name?.match(/^heading ([1-6])$/i)?.[1];
          if (level && id !== `Heading${level}`) headings.set(id, `Heading${level}`);
        }
        if (outlines.size || headings.size)
          for (const pStyle of all(doc, "pStyle", ["pPrChange"])) {
            const id = pStyle.attrs.val ?? "";
            const outline = wordStyleOutlineLevel(outlines, id);
            if (outline !== undefined) pStyle.wordOutlineHeadingLevel = outline;
            else {
              const heading = headings.get(id);
              if (heading) pStyle.attrs.val = heading;
            }
          }
      }
      yield* paragraphs(doc);
    } else if ([".odt", ".ods", ".odp"].includes(extension)) {
      const odfFamily = (): OdfStyleFamily => ({ common: new Map(), automatic: new Map() });
      const odfTextStyles: OdfTextStyles | undefined =
        extension === ".odt" ? { text: odfFamily(), paragraph: odfFamily() } : undefined;
      if (odfTextStyles) {
        const namedStyles = files.get(part("styles.xml"));
        if (namedStyles !== undefined) {
          try {
            xml(namedStyles, extension, undefined, odfTextStyles);
          } catch {
            // A partial or oversized optional styles part must not hide otherwise readable text.
            odfTextStyles.text = odfFamily();
            odfTextStyles.paragraph = odfFamily();
          }
        }
      }
      const content = read("content.xml", undefined, odfTextStyles);
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
      const dateSystem = /^[ \t\r\n]*(?:1|true)[ \t\r\n]*$/.test(
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
      const populatedStrings = strings.map(hasXstringText);
      for (const sheet of all(workbook, "sheet")) {
        const sheetName = sheet.attrs.name && decodeXstring(sheet.attrs.name);
        yield `\n## Sheet: ${sheetName}\n`;
        const target = rels.get(sheet.attrs["r:id"] ?? sheet.attrs.id)?.Target;
        if (!target) {
          skip(`sheet relationship ${sheetName}`);
          continue;
        }
        const name = resolveWorkbookPart(target);
        const populated = (cell: XmlNode) => {
          const value = all(cell, "v").next().value;
          if (cell.attrs.t === "s") {
            const raw = value?.children.find((child) => typeof child === "string")?.trim();
            return !!raw && !!populatedStrings[Number(raw)];
          }
          if (cell.attrs.t === "inlineStr") return hasXstringText(cell);
          if (value && hasXstringText(value)) return true;
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
              if (value && hasXstringText(value)) yield* inCell(xstringText(value));
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
        else if (!has(rootfile)) {
          const normalized = NodePath.posix.normalize(decoded);
          if (files.has(normalized)) rootfile = normalized;
        }
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
  let rtfNote: string | undefined;
  let endsWithWord = false;
  let afterImageDescription = false;
  let truncated = false;
  const takeRaw = (raw: string) => {
    const value = raw.slice(0, remaining).replaceAll("\0", "");
    remaining -= Math.min(raw.length, remaining);
    return value;
  };
  try {
    // Charge raw text before normalization so repeated whitespace also exhausts the budget.
    for await (let part of document(path, extension)) {
      if (part === RTF_NOTE_START) {
        rtfNote = "";
        continue;
      }
      if (part === RTF_NOTE_END) {
        const note = rtfNote!.trimEnd();
        rtfNote = undefined;
        if (!note) continue;
        result += note;
        part = "]";
      }
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
      let isColumnGap = false;
      if (typeof part === "string") raw = part;
      else if ("columnGap" in part) {
        raw = "\t".repeat(part.columnGap);
        isColumnGap = true;
      } else if ("imageDescription" in part) {
        raw = part.imageDescription;
        isImageDescription = true;
      } else if ("notebookOutput" in part) {
        // Charge leading whitespace as it arrives, but render it only with readable output.
        let pending: string | undefined = "";
        for (const output of part.notebookOutput) {
          if (pending !== undefined) {
            if (NOTEBOOK_OUTPUT_TEXT.test(output.slice(0, remaining))) {
              const roomAfterHeading = Math.max(0, remaining - NOTEBOOK_OUTPUT_HEADING.length);
              const fittingOutput =
                output.length < roomAfterHeading
                  ? output
                  : output.slice(0, roomAfterHeading).replace(TRAILING_HIGH_SURROGATE, "");
              if (!NOTEBOOK_OUTPUT_TEXT.test(fittingOutput)) throw new Truncation("Output budget");
              result += takeRaw(NOTEBOOK_OUTPUT_HEADING) + pending;
              pending = undefined;
              midLine = false;
            }
          }
          const value = takeRaw(output);
          if (pending !== undefined) pending += value;
          else {
            result += value;
            midLine = endsMidLine(value) ?? midLine;
          }
          if (remaining === 0) throw new Truncation("Output budget");
        }
        continue;
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
      if (rtfNote === "" && /\S/u.test(raw.replaceAll("\0", ""))) result += takeRaw("[Note: ");
      let value = takeRaw(raw);
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
        // Trim leading text whitespace here so leading table column gaps survive trimEnd().
        if (!result && !isColumnGap) value = value.trimStart();
        midLine = endsMidLine(value) ?? midLine;
      }
      if (rtfNote === undefined) result += value;
      else rtfNote += rtfNote === "" ? value.trimStart() : value;
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
  if (rtfNote !== undefined) result += rtfNote;
  result = result.replaceAll(/\n(?:[ \t]*\n){2,}/g, "\n\n").trimEnd();
  if (!result && !truncated) throw new Error("No text extracted");
  return truncated ? result.replace(TRAILING_HIGH_SURROGATE, "").trimEnd() + TRUNCATED : result;
}
