import JSZip from "jszip";
import { checkZipDirectory } from "./zipDirectory";
import { SaxesParser } from "saxes";
import { externalUrl } from "./office/links";

import {
  OFFICE_PREVIEW_MAX_BYTES,
  OFFICE_PREVIEW_MAX_COLUMNS,
  OFFICE_PREVIEW_MAX_ROWS,
  type OfficeWorkerRequest,
} from "./officePreviewProtocol";

function xmlParser() {
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    throw new Error("This document contains unsupported XML declarations.");
  });
  return parser;
}

function officeXmlDecoder(bytes: Uint8Array) {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0))
    return new TextDecoder("utf-16le");
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c))
    return new TextDecoder("utf-16be");
  const declaration = new TextDecoder().decode(bytes.subarray(0, 256));
  return new TextDecoder(/^<\?xml\s[^?]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(declaration)?.[1]);
}

function officeXml(bytes: Uint8Array) {
  // Repacked XML is UTF-8, regardless of the source part's encoding.
  return officeXmlDecoder(bytes)
    .decode(bytes)
    .replace(/^(<\?xml\s[^?]*\bencoding\s*=\s*)["'][^"']+["']/i, '$1"UTF-8"');
}

// Section properties terminate the section they describe, so the kept prefix
// may depend on a paragraph or body section beyond the retained input window.
function wordSections() {
  const parser = xmlParser();
  const names: string[] = [];
  const namespaceScopes: Record<string, string>[] = [];
  const sections: { end: number; xml: string; body: boolean }[] = [];
  let window = "";
  let offset = 0;
  let capture: {
    start: number;
    insert: number;
    namespaces: string;
    body: boolean;
    depth: number;
  } | null = null;
  let bytes = 0;
  let tags = 0;
  let nextParagraph = false;
  let paragraphSection = false;
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  parser.on("opentag", (tag) => {
    names.push(tag.local);
    namespaceScopes.push(tag.ns);
    if (names.length > 64) throw new Error("This Word document has excessive XML nesting.");
    const body = names.length === 3 && names[1] === "body";
    if (
      tag.local === "sectPr" &&
      tag.uri === "http://schemas.openxmlformats.org/wordprocessingml/2006/main" &&
      (body || (names.length === 5 && names[2] === "p" && names[3] === "pPr" && !nextParagraph))
    ) {
      let namespaces = "";
      const scope = Object.assign({}, ...namespaceScopes) as Record<string, string>;
      for (const prefix in scope) {
        const name = prefix ? `xmlns:${prefix}` : "xmlns";
        if (prefix !== "xml" && !tag.attributes[name])
          namespaces += ` ${name}="${escape(scope[prefix]!)}"`;
      }
      const start = window.lastIndexOf("<", parser.position - offset - 1);
      if (start < 0) throw new Error("This Word document has too much section markup.");
      capture = {
        start: start + offset,
        insert: parser.position - (tag.isSelfClosing ? 2 : 1),
        namespaces,
        body,
        depth: names.length,
      };
    }
    if (capture && ++tags > 2_000)
      throw new Error("Preview limited: this Word document has too much section markup.");
  });
  parser.on("closetag", (tag) => {
    if (capture && tag.local === "sectPr" && names.length === capture.depth) {
      const xml =
        window.slice(capture.start - offset, capture.insert - offset) +
        capture.namespaces +
        window.slice(capture.insert - offset, parser.position - offset);
      bytes += xml.length;
      if (bytes > 128 * 1024)
        throw new Error("Preview limited: this Word document has too much section markup.");
      sections.push({ end: parser.position, xml, body: capture.body });
      paragraphSection = !capture.body;
      if (!capture.body && parser.position > 4 * 1024 * 1024) nextParagraph = true;
      capture = null;
    }
    if (names.length === 3 && tag.local === "p" && paragraphSection) {
      sections[sections.length - 1]!.end = parser.position;
      paragraphSection = false;
    }
    names.pop();
    namespaceScopes.pop();
  });
  return {
    write(chunk: string) {
      window += chunk;
      parser.write(chunk);
      if (capture && parser.position - capture.start > 128 * 1024)
        throw new Error("Preview limited: this Word document has too much section markup.");
      const keep = capture?.start ?? Math.max(offset, parser.position - 128 * 1024);
      window = window.slice(keep - offset);
      offset = keep;
    },
    finish() {
      parser.close();
      return sections;
    },
  };
}

// Keep whole body elements so every prefix and render batch is valid Word XML.
// Individual tables/paragraphs are bounded too: one giant element must not
// bypass the budget between yields on the main thread.
function wordDocuments(
  xml: string,
  incomplete: boolean,
  sections: ReturnType<ReturnType<typeof wordSections>["finish"]>,
) {
  const parser = xmlParser();
  const names: string[] = [];
  const batches: { content: string; end: number }[] = [];
  let prefix = "";
  let suffix = "";
  let boundary = 0;
  let batchStart = 0;
  let tags = 0;
  let elementTags = 0;
  let batchTags = 0;
  let elements = 0;
  let truncated = incomplete;
  const limit = Symbol("Word preview limit");
  parser.on("opentag", (tag) => {
    names.push(tag.name);
    if (names.length === 2 && tag.local === "body") {
      prefix = xml.slice(0, parser.position).replace(/\/>$/, ">");
      suffix = `</${tag.name}></${names[0]}>`;
      boundary = batchStart = parser.position;
    } else if (prefix && names.length > 2) {
      if (names.length === 3 && ++elements > 5_000) throw limit;
      tags++;
      elementTags++;
      batchTags++;
      if (tags > 100_000 || elementTags > 2_000 || parser.position - boundary > 128 * 1024)
        throw limit;
    }
    if (names.length > 64) throw limit;
  });
  parser.on("closetag", (tag) => {
    if (prefix && names.length === 3 && tag.local !== "sectPr") {
      if (parser.position - prefix.length > 3 * 1024 * 1024) throw limit;
      boundary = parser.position;
      elementTags = 0;
      if (batchTags >= 500) {
        batches.push({ content: xml.slice(batchStart, boundary), end: boundary });
        batchStart = boundary;
        batchTags = 0;
      }
    }
    names.pop();
  });
  try {
    for (let offset = 0; offset < xml.length; offset += 16 * 1024) {
      parser.write(xml.slice(offset, offset + 16 * 1024));
      if (prefix && parser.position - boundary > 128 * 1024) throw limit;
    }
    if (!incomplete) parser.close();
  } catch (cause) {
    if (cause !== limit) throw cause;
    truncated = true;
  }
  if (!prefix) throw new Error("This Word document has no readable body.");
  if (boundary > batchStart || batches.length === 0)
    batches.push({ content: xml.slice(batchStart, boundary), end: boundary });
  const documents: string[] = [];
  let length = 0;
  let markup = 0;
  for (const batch of batches) {
    const section = sections.find((section) => section.body || section.end >= batch.end);
    const document = prefix + batch.content + (section?.xml ?? "") + suffix;
    length += batch.content.length;
    markup += batch.content.match(/<(?![!?/])/g)?.length ?? 0;
    if (length > 3 * 1024 * 1024 || markup > 100_000) {
      truncated = true;
      break;
    }
    documents.push(document);
  }
  if (documents.length === 0) throw new Error("This Word document has too much section markup.");
  return { documents, truncated };
}

function boundedWorksheet(
  xml: string,
  strings: readonly string[],
  budget: { remaining: number; cells: number },
) {
  const parser = xmlParser();
  const rows = new Map<number, Map<number, string>>();
  const rowTags = new Map<number, string>();
  const metadataAttributes = new Map<
    string,
    { ref: string | undefined; min: string | undefined; max: string | undefined }
  >();
  let dataStart = 0;
  let dataEnd = 0;
  let emptyData = false;
  let depth = 0;
  let row = 0;
  let explicitRow = false;
  let rowTag = "";
  let column = 0;
  let maxRow = 0;
  let maxColumn = 0;
  let cells = new Map<number, string>();
  let cell: {
    start: number;
    opening: string;
    name: string;
    prefix: string;
    selfClosing: boolean;
    text: string;
    value: string;
    reading: string;
    shared: boolean;
  } | null = null;
  let truncated = false;
  const coordinate = (ref: string) => {
    const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref);
    if (!match) throw new Error("This workbook contains invalid cell coordinates.");
    let col = 0;
    for (const letter of match[1]!) col = col * 26 + letter.charCodeAt(0) - 64;
    const line = Number(match[2]);
    if (col > 16384 || line > 1048576)
      throw new Error("This workbook contains invalid worksheet dimensions.");
    return { col, line };
  };
  parser.on("opentag", (tag) => {
    depth++;
    if (depth > 64) throw new Error("This workbook contains excessive XML nesting.");
    if (
      (tag.local === "row" && depth !== 3) ||
      (tag.local === "c" && depth !== 4) ||
      ((tag.local === "dimension" || tag.local === "sheetData") && depth !== 2)
    )
      throw new Error("This workbook contains invalid worksheet structure.");
    const attribute = (name: string) => tag.attributes[name]?.value;
    if (["dimension", "mergeCell", "col"].includes(tag.local))
      metadataAttributes.set(
        xml.slice(xml.lastIndexOf("<", parser.position - 1), parser.position),
        {
          ref: attribute("ref"),
          min: attribute("min"),
          max: attribute("max"),
        },
      );
    if (depth === 2 && tag.local === "sheetData") {
      dataStart = parser.position;
      emptyData = tag.isSelfClosing;
    }
    if (depth === 2 && tag.local === "dimension") {
      for (const ref of (attribute("ref") ?? "").split(":")) {
        const { col, line } = coordinate(ref);
        if (col > OFFICE_PREVIEW_MAX_COLUMNS || line > OFFICE_PREVIEW_MAX_ROWS) truncated = true;
      }
    } else if (depth === 3 && tag.local === "row") {
      explicitRow = attribute("r") !== undefined;
      row = attribute("r") === undefined ? row + 1 : Number(attribute("r"));
      if (!Number.isInteger(row) || row < 1 || row > 1048576)
        throw new Error("This workbook contains invalid row coordinates.");
      rowTag = xml
        .slice(xml.lastIndexOf("<", parser.position - 1), parser.position)
        .replace(/\/>$/, ">");
      column = 0;
      cells = rows.get(row) ?? new Map<number, string>();
      if (row > OFFICE_PREVIEW_MAX_ROWS)
        throw new Error("This workbook exceeds the preview limit: 250,000 rows.");
    } else if (depth === 4 && tag.local === "c") {
      const ref = attribute("r");
      const position = ref ? coordinate(ref) : { col: column + 1, line: row };
      if (!explicitRow && column === 0) row = position.line;
      column = position.col;
      if (row < 1 || position.line !== row)
        throw new Error("This workbook contains inconsistent cell rows.");
      if (row > OFFICE_PREVIEW_MAX_ROWS || column > OFFICE_PREVIEW_MAX_COLUMNS) {
        truncated = true;
        return;
      }
      maxRow = Math.max(maxRow, row);
      maxColumn = Math.max(maxColumn, column);
      if (++budget.cells > 2_000_000 || maxRow * maxColumn > 8_000_000)
        throw new Error(
          "This workbook exceeds the preview limit: 2 million cells or 8 million grid positions.",
        );
      // Explicit coordinates also bound sheets whose rows/cells omit r.
      let letters = "";
      for (let value = column; value > 0; value = Math.floor((value - 1) / 26))
        letters = String.fromCharCode(65 + ((value - 1) % 26)) + letters;
      const style = attribute("s");
      const type = attribute("t");
      if ((style && !/^\d{1,6}$/.test(style)) || (type && !/^[a-zA-Z]+$/.test(type)))
        throw new Error("This workbook contains invalid cell metadata.");
      cell = {
        start: parser.position,
        opening: xml
          .slice(xml.lastIndexOf("<", parser.position - 1), parser.position)
          .replace(/\/?>$/, `${ref ? "" : ` r="${letters}${row}"`}>`),
        name: tag.name,
        prefix: tag.prefix ? `${tag.prefix}:` : "",
        selfClosing: tag.isSelfClosing,
        text: "",
        value: "",
        reading: "",
        shared: type === "s",
      };
    }
    if (cell && (tag.local === "t" || tag.local === "v")) cell.reading = tag.local;
  });
  const readCellText = (chunk: string) => {
    if (cell?.reading === "t") cell.text += chunk;
    if (cell?.reading === "v") cell.value += chunk;
  };
  parser.on("text", readCellText);
  parser.on("cdata", readCellText);
  parser.on("closetag", (tag) => {
    if (depth === 4 && tag.local === "c" && cell) {
      const end = cell.selfClosing ? cell.start : xml.lastIndexOf("<", parser.position - 1);
      const raw = cell.opening + xml.slice(cell.start, end) + `</${cell.name}>`;
      const shown = cell.shared ? (strings[Number(cell.value)] ?? "") : cell.text || cell.value;
      const kept = shown.slice(0, Math.min(4096, budget.remaining));
      budget.remaining -= kept.length;
      if (kept.length < shown.length) {
        truncated = true;
        const escape = (s: string) =>
          s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        cells.set(
          column,
          cell.opening
            .replace(/\s+t\s*=\s*(?:"[^"]*"|'[^']*')/, "")
            .replace(/>$/, ' t="inlineStr">') +
            `<${cell.prefix}is><${cell.prefix}t>` +
            escape(kept) +
            `</${cell.prefix}t></${cell.prefix}is></${cell.name}>`,
        );
      } else cells.set(column, raw);
      cell = null;
    } else if (depth === 3 && tag.local === "row" && row <= OFFICE_PREVIEW_MAX_ROWS) {
      rows.set(row, cells);
      rowTags.set(row, rowTag);
    }
    if (depth === 2 && tag.local === "sheetData")
      dataEnd = emptyData ? parser.position : xml.lastIndexOf("<", parser.position - 1);
    if (cell?.reading === tag.local) cell.reading = "";
    depth--;
  });
  parser.write(xml).close();
  if (!dataStart) throw new Error("This workbook has no worksheet data.");
  const boundRange = (ref: string) => {
    const [a, b = a] = ref.split(":");
    const first = coordinate(a!);
    const last = coordinate(b!);
    if (first.col > OFFICE_PREVIEW_MAX_COLUMNS || first.line > OFFICE_PREVIEW_MAX_ROWS) return "";
    let letters = "";
    for (
      let col = Math.min(OFFICE_PREVIEW_MAX_COLUMNS, last.col);
      col > 0;
      col = Math.floor((col - 1) / 26)
    )
      letters = String.fromCharCode(65 + ((col - 1) % 26)) + letters;
    return a + ":" + letters + Math.min(OFFICE_PREVIEW_MAX_ROWS, last.line);
  };
  const metadata = (part: string) =>
    part.replace(
      /(<((?:\w+:)?(?:dimension|mergeCell|col))\b(?:[^"'<>]|"[^"]*"|'[^']*')*>)(?:\s*<\/\2\s*>)?/g,
      (tag: string, opening: string) => {
        const attributes = metadataAttributes.get(opening);
        if (!attributes) return tag;
        const replace = (name: string, value: string) => {
          const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`);
          tag = pattern.test(tag)
            ? tag.replace(pattern, ` ${name}="${value}"`)
            : tag.replace(/\/?>/, (end) => ` ${name}="${value}"${end}`);
        };
        if (attributes.ref !== undefined) {
          const bounded = boundRange(attributes.ref);
          if (!bounded) return "";
          replace("ref", bounded);
        }
        if (/<(?:\w+:)?col\b/.test(opening)) {
          const min = Math.max(1, Number(attributes.min ?? 1));
          const max = Math.min(OFFICE_PREVIEW_MAX_COLUMNS, Number(attributes.max ?? 16384));
          if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) return "";
          replace("min", String(min));
          replace("max", String(max));
        }
        return tag;
      },
    );
  return {
    xml: emptyData
      ? metadata(xml)
      : `${metadata(xml.slice(0, dataStart))}${[...rows]
          .sort(([a], [b]) => a - b)
          .map(
            ([line, values]) =>
              `${rowTags.get(line) ?? `<row r="${line}">`}${[...values]
                .sort(([a], [b]) => a - b)
                .map(([, value]) => value)
                .join("")}</${/^<([^\s>]+)/.exec(rowTags.get(line) ?? "<row>")![1]}>`,
          )
          .join("")}${metadata(xml.slice(dataEnd))}`,
    truncated,
  };
}

async function boundWorkbook(archive: JSZip) {
  const paths = new Map<string, string>();
  let sharedPath = "xl/sharedStrings.xml";
  const relationships = xmlParser();
  relationships.on("opentag", (tag) => {
    if (tag.local !== "Relationship") return;
    const type = tag.attributes.Type?.value;
    const path = new URL(
      tag.attributes.Target?.value ?? "",
      "https://docx.invalid/xl/workbook.xml",
    ).pathname.slice(1);
    if (type?.endsWith("/worksheet")) paths.set(tag.attributes.Id?.value ?? "", path);
    if (type?.endsWith("/sharedStrings")) sharedPath = path;
  });
  relationships
    .write((await archive.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "")
    .close();
  const sheetPaths: string[] = [];
  const workbook = xmlParser();
  workbook.on("opentag", (tag) => {
    if (tag.local !== "sheet") return;
    const id = Object.values(tag.attributes).find((attribute) => attribute.local === "id")?.value;
    const path = paths.get(id ?? "");
    if (!path || sheetPaths.length === 100)
      throw new Error("This workbook has invalid or too many sheets.");
    sheetPaths.push(path);
  });
  workbook.write((await archive.file("xl/workbook.xml")?.async("string")) ?? "").close();
  const strings: string[] = [];
  const shared = await archive.file(sharedPath)?.async("string");
  if (shared) {
    const parser = xmlParser();
    let text = "";
    let reading = false;
    parser.on("opentag", (tag) => {
      if (tag.local === "si") text = "";
      if (tag.local === "t") reading = true;
    });
    const readSharedText = (chunk: string) => {
      if (reading) text += chunk;
    };
    parser.on("text", readSharedText);
    parser.on("cdata", readSharedText);
    parser.on("closetag", (tag) => {
      if (tag.local === "t") reading = false;
      if (tag.local === "si") strings.push(text);
    });
    parser.write(shared).close();
  }
  const budget = { remaining: 1024 * 1024, cells: 0 };
  const limited = new Map<string, boolean>();
  for (const path of new Set(sheetPaths)) {
    const file = archive.file(path);
    if (!file) throw new Error("This workbook has a missing worksheet.");
    const sheet = boundedWorksheet(await file.async("string"), strings, budget);
    archive.file(path, sheet.xml);
    limited.set(path, sheet.truncated);
  }
  return sheetPaths.map((path) => limited.get(path) ?? false);
}

const WORD_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const WORD_EXPANDED_PARTS = new Set(["footnotes", "endnotes", "comments", "header", "footer"]);
const WORD_DISABLED_PARTS = new Set(["commentsExtended", "fontTable", "aFChunk"]);
const WORD_BINARY_PARTS = new Set([
  "image",
  "font",
  "thumbnail",
  "audio",
  "video",
  "oleObject",
  "package",
  "printerSettings",
  "vbaProject",
  "origin",
  "certificate",
  // Package metadata can point to binary payloads; explicit XML still wins below.
  "core-properties",
  "extended-properties",
  "custom-properties",
  "signature",
]);

function wordPartTypes() {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  const xmlParts = new Set([
    "word/document.xml",
    "docProps/app.xml",
    "docProps/core.xml",
    "docProps/custom.xml",
  ]);
  const roles = new Map<string, Set<string>>();
  const relationships = new Map<string, Map<string, string>>();
  return {
    roles,
    relationships,
    binary(path: string) {
      const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
      const type = overrides.get(path) ?? defaults.get(extension) ?? "";
      // An XML relationship always wins over a misleading media content type.
      if (
        path === "[Content_Types].xml" ||
        extension === "rels" ||
        extension === "xml" ||
        xmlParts.has(path) ||
        /(?:\+xml|\/xml)$/i.test(type)
      )
        return false;
      return (
        [...(roles.get(path) ?? [])].some((role) => WORD_BINARY_PARTS.has(role)) ||
        /^(?:image|audio|video|font)\//i.test(type) ||
        /^(?:png|jpe?g|gif|webp|bmp|tiff?|ico|bin|sigs|cer|ttf|otf|odttf|woff2?)$/.test(
          extension,
        ) ||
        type === "application/octet-stream" ||
        type === "application/vnd.openxmlformats-package.digital-signature-origin"
      );
    },
    metadata(path: string, xml: string) {
      const parser = xmlParser();
      const removed: { start: number; end: number }[] = [];
      let start = -1;
      parser.on("opentag", (tag) => {
        const attr = (name: string) => tag.attributes[name]?.value ?? "";
        if (path === "[Content_Types].xml") {
          if (tag.local === "Default")
            defaults.set(attr("Extension").toLowerCase(), attr("ContentType"));
          if (tag.local === "Override")
            overrides.set(attr("PartName").replace(/^\//, ""), attr("ContentType"));
        }
        if (tag.local !== "Relationship" || !path.endsWith(".rels")) return;
        const type = attr("Type");
        const role = type.slice(type.lastIndexOf("/") + 1);
        const external =
          attr("TargetMode").toLowerCase() === "external" ||
          /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(attr("Target"));
        const folder = path === "_rels/.rels" ? "" : path.replace(/_rels\/[^/]+\.rels$/, "");
        // Preserve archive URL resolution, including literal query/fragment
        // characters in ZIP names rather than silently classifying another file.
        const target = new URL(attr("Target"), `https://docx.invalid/${folder}`)
          .toString()
          .slice("https://docx.invalid/".length);
        if (!external) {
          if (
            !WORD_BINARY_PARTS.has(role) &&
            role !== "hyperlink" &&
            (type.startsWith(WORD_RELATIONSHIP) ||
              role === "core-properties" ||
              role === "signature")
          )
            xmlParts.add(target);
          const types = roles.get(target) ?? new Set<string>();
          types.add(role);
          roles.set(target, types);
          const owner = path === "_rels/.rels" ? "" : path.replace(/_rels\/([^/]+)\.rels$/, "$1");
          const refs = relationships.get(owner) ?? new Map<string, string>();
          if (!refs.has(attr("Id"))) refs.set(attr("Id"), target);
          relationships.set(owner, refs);
          if (target === "word/document.xml" && role !== "officeDocument")
            throw new Error("Preview limited: this Word document has an aliased document part.");
          if (type === WORD_RELATIONSHIP + "officeDocument" && target !== "word/document.xml")
            throw new Error(
              "Preview limited: this Word document has an unsupported document relationship.",
            );
        }
        if (
          (external && !(role === "hyperlink" && externalUrl(attr("Target")))) ||
          WORD_DISABLED_PARTS.has(role)
        ) {
          start = xml.lastIndexOf("<", parser.position - 1);
        }
      });
      parser.on("closetag", (tag) => {
        if (tag.local === "Relationship" && start >= 0) {
          removed.push({ start, end: parser.position });
          start = -1;
        }
      });
      parser.write(xml).close();
      for (const range of removed.toReversed())
        xml = xml.slice(0, range.start) + xml.slice(range.end);
      return xml;
    },
  };
}

// Bound inherited style and numbering expansion before the engine loads it.
// Picture bullets can duplicate embedded images, so omit those definitions.
const WORD_STYLE_MAX_BYTES = 1024 * 1024;
const WORD_STYLE_MAX_UNITS = 20_000;

function wordXmlCost(xml: string, roles: Set<string> | undefined) {
  const parser = xmlParser();
  let depth = 0;
  let markup = 0;
  const limit = Symbol("Word style budget");
  const exceeded = { bytes: Infinity, markup: Infinity, pictures: false };
  let styleCount = 0;
  let ownUnits = 0;
  const styles = new Map<
    string,
    { properties: Map<string, number>; base: string; linked: string }
  >();
  let style: { id: string; base: string; linked: string; properties: Map<string, number> } | null =
    null;
  const names: string[] = [];
  const definitions = new Map<string, { bytes: number; markup: number }>();
  const references: { id: string; selector: number }[] = [];
  let definition: { id: string; start: number; markup: number } | null = null;
  let reference: { id: string; selector: number } | null = null;
  let pictures = false;
  parser.on("opentag", (tag) => {
    if (++depth > 64)
      throw new Error("Preview limited: this Word document has excessive XML nesting.");
    markup++;
    const attr = (name: string) =>
      Object.values(tag.attributes).find((a) => a.local === name)?.value ?? "";
    names.push(tag.local === "tblStylePr" ? `${tag.local}:${attr("type")}` : tag.local);
    if (roles?.has("styles") && (tag.local === "style" || tag.local === "docDefaults")) {
      if (++styleCount > 1_024 || attr("styleId").length > 256) throw limit;
      style = { id: attr("styleId"), properties: new Map(), base: "", linked: "" };
    }
    if (style) {
      if (tag.local === "basedOn") style.base = attr("val");
      else if (tag.local === "link") style.linked = attr("val");
      else if (names.length > 2 && tag.local !== "name") {
        const key = names.slice(2).join("/");
        const size = new TextEncoder().encode(
          xml.slice(xml.lastIndexOf("<", parser.position - 1), parser.position),
        ).length;
        if (++ownUnits > WORD_STYLE_MAX_UNITS) throw limit;
        style.properties.set(key, size);
      }
    }
    if (roles?.has("numbering")) {
      if (tag.local === "abstractNum")
        definition = {
          id: attr("abstractNumId"),
          start: xml.lastIndexOf("<", parser.position - 1),
          markup: markup - 1,
        };
      if (tag.local === "num") {
        if (references.length >= 2_000) throw limit;
        reference = { id: "", selector: attr("numId").length + 32 };
        references.push(reference);
      }
      if (tag.local === "abstractNumId" && reference) reference.id = attr("val");
    }
    if (tag.local === "numPicBullet") pictures = true;
  });
  parser.on("closetag", (tag) => {
    if (definition && tag.local === "abstractNum") {
      const previous = definitions.get(definition.id);
      definitions.set(definition.id, {
        bytes:
          (previous?.bytes ?? 0) +
          new TextEncoder().encode(xml.slice(definition.start, parser.position)).length,
        markup: (previous?.markup ?? 0) + markup - definition.markup,
      });
      definition = null;
    }
    if (tag.local === "num") reference = null;
    if (style && (tag.local === "style" || tag.local === "docDefaults")) {
      styles.set(style.id, style);
      style = null;
    }
    names.pop();
    depth--;
  });
  try {
    parser.write(xml).close();
  } catch (cause) {
    if (cause !== limit) throw cause;
    return exceeded;
  }
  const rawBytes = new TextEncoder().encode(xml).length;
  if (roles?.has("styles")) {
    // Immutable parent pointers match processStyles' ordered merges (including
    // forward links and cycles) without copying an expanding property map.
    type Resolved = {
      properties: Map<string, number>;
      parent?: Resolved | undefined;
      depth: number;
    };
    const resolved = new Map<string, Resolved>();
    for (const [id, style] of styles) resolved.set(id, { properties: style.properties, depth: 1 });
    for (const [id, style] of styles) {
      const parent = style.base ? resolved.get(style.base) : undefined;
      if (parent && parent.depth >= 32) return exceeded;
      resolved.set(id, { properties: style.properties, parent, depth: (parent?.depth ?? 0) + 1 });
    }
    let bytes = 0;
    let expandedMarkup = 0;
    let visited = 0;
    let propertyVisits = 0;
    for (const [id, style] of styles) {
      for (const root of [
        resolved.get(id),
        style.linked ? resolved.get(style.linked) : undefined,
      ]) {
        const seen = new Set<string>();
        for (let node = root; node; node = node.parent) {
          if (++visited > 8_192) return exceeded;
          for (const [key, size] of node.properties) {
            if (++propertyVisits > 100_000) return exceeded;
            if (seen.has(key)) continue;
            // Latent styles never enter properties. Charge each own property
            // once per resolved style, including linked and default selectors.
            const copies = id ? 1 : 2;
            bytes += (size * 2 + id.length + 32) * copies;
            expandedMarkup += copies;
            if (bytes > WORD_STYLE_MAX_BYTES || expandedMarkup > WORD_STYLE_MAX_UNITS)
              return exceeded;
            seen.add(key);
          }
        }
      }
    }
    return { bytes, markup: expandedMarkup, pictures };
  }
  let bytes = rawBytes;
  if (roles?.has("numbering")) {
    for (const ref of references) {
      const cost = definitions.get(ref.id);
      if (!cost) continue;
      bytes += cost.bytes * 2 + cost.markup * ref.selector;
      markup += cost.markup;
      if (bytes > 128 * 1024 || markup > 2_000) return exceeded;
    }
  }
  return { bytes, markup, pictures };
}

// Layout can repeat notes at references and headers/footers across pages.
// Charge those copies, not just the XML that defines them.
async function wordExpansion(
  archive: JSZip,
  parts: ReturnType<typeof wordPartTypes>,
  mediaSizes: Map<string, number>,
  auxiliaryCosts: Map<string, { bytes: number; markup: number }>,
  documents: string[],
) {
  type Cost = { bytes: number; markup: number; media: number; images: Set<string> };
  const empty = (): Cost => ({ bytes: 0, markup: 0, media: 0, images: new Set() });
  const nodes = new Map<string, { xml: string; path: string }>();
  const optional = new Set<string>();
  const noteParts = new Map<string, string>();
  for (const [path, roles] of parts.roles) {
    if (![...roles].some((role) => WORD_EXPANDED_PARTS.has(role))) continue;
    const xml = await archive.file(path)?.async("string");
    if (!xml) continue;
    optional.add(path);
    if (roles.has("header") || roles.has("footer")) nodes.set(path, { xml, path });
    for (const role of ["footnotes", "endnotes", "comments"]) {
      if (!roles.has(role)) continue;
      noteParts.set(role.slice(0, -1), path);
      const parser = xmlParser();
      let start = 0;
      let id = "";
      let depth = 0;
      let prefix = "";
      let suffix = "";
      parser.on("opentag", (tag) => {
        if (++depth === 1) {
          prefix = xml.slice(0, parser.position);
          suffix = `</${tag.name}>`;
        }
        if (tag.local !== role.slice(0, -1)) return;
        start = xml.lastIndexOf("<", parser.position - 1);
        id = Object.values(tag.attributes).find((attr) => attr.local === "id")?.value ?? "";
      });
      parser.on("closetag", (tag) => {
        if (tag.local === role.slice(0, -1))
          nodes.set(`${path}#${id}`, {
            xml: prefix + xml.slice(start, parser.position) + suffix,
            path,
          });
        depth--;
      });
      parser.write(xml).close();
    }
  }
  const used = new Set<string>();
  const memo = new Map<string, Cost>();
  let expandedXmlBytes = 0;
  const scan = (xml: string, path: string, chain: Set<string>, pages = 1, expand = true): Cost => {
    const cost = empty();
    const refs = new Map<string, number>();
    const headers = new Set<string>();
    const parser = xmlParser();
    const add = (key: string) => refs.set(key, (refs.get(key) ?? 0) + 1);
    parser.on("opentag", (tag) => {
      const attr = (name: string) =>
        Object.values(tag.attributes).find((a) => a.local === name)?.value ?? "";
      const note = /^(footnote|endnote|comment)Reference$/.exec(tag.local)?.[1];
      if (note && noteParts.has(note)) add(`${noteParts.get(note)}#${attr("id")}`);
      if (tag.local === "headerReference" || tag.local === "footerReference") {
        const target = parts.relationships.get(path)?.get(attr("id"));
        if (target) headers.add(target);
      }
      if (tag.local === "altChunk") cost.bytes = Infinity;
      if (tag.local !== "blip" && tag.local !== "imagedata") return;
      const target = parts.relationships.get(path)?.get(attr("embed") || attr("id"));
      if (target) {
        cost.media += mediaSizes.get(target) ?? OFFICE_PREVIEW_MAX_BYTES + 1;
        cost.images.add(target);
      }
    });
    parser.write(xml).close();
    for (const header of headers) refs.set(header, pages);
    if (!expand) return cost;
    for (const [key, copies] of refs) {
      const node = nodes.get(key);
      if (!node) continue;
      used.add(node.path);
      if (chain.has(key) || chain.size >= 64) {
        cost.bytes = Infinity;
        break;
      }
      let expanded = memo.get(key);
      if (!expanded) {
        expandedXmlBytes += node.xml.length * 2;
        if (expandedXmlBytes > 3 * 1024 * 1024) {
          cost.bytes = Infinity;
          break;
        }
        const own = wordXmlCost(node.xml, undefined);
        expanded = scan(node.xml, node.path, new Set([...chain, key]));
        expanded.bytes += own.bytes;
        expanded.markup += own.markup;
        memo.set(key, expanded);
      }
      cost.bytes += expanded.bytes * copies;
      cost.markup += expanded.markup * copies;
      cost.media += expanded.media * copies;
      for (const image of expanded.images) cost.images.add(image);
    }
    return cost;
  };
  const costs = new Map<string, Cost>();
  let bytes = 0;
  let markup = 0;
  let media = 0;
  // Styles may introduce a page break before each styled paragraph. The page
  // bound also includes explicit breaks and section transitions in each batch.
  let stylePageBreaks = false;
  for (const [path, roles] of parts.roles)
    if (
      roles.has("styles") &&
      /<(?:\w+:)?pageBreakBefore\b/.test((await archive.file(path)?.async("string")) ?? "")
    )
      stylePageBreaks = true;
  for (const document of documents) {
    const pages = Math.max(
      1,
      document.match(
        stylePageBreaks ? /<(?:\w+:)?p\b/g : /<(?:\w+:)?(?:br|pageBreakBefore|sectPr)\b/g,
      )?.length ?? 0,
    );
    const expanded = scan(document, "word/document.xml", new Set(), pages);
    const body = wordXmlCost(document, undefined);
    bytes += body.bytes + expanded.bytes;
    markup += body.markup + expanded.markup;
    media += expanded.media;
    costs.set(document, expanded);
  }
  for (const [path, cost] of auxiliaryCosts) {
    if (optional.has(path) && !used.has(path)) continue;
    bytes += cost.bytes;
    markup += cost.markup;
  }
  const overBudget =
    bytes > 3 * 1024 * 1024 || markup > 100_000 || media > OFFICE_PREVIEW_MAX_BYTES;
  const truncated = (used.size > 0 && overBudget) || bytes === Infinity;
  const omitted = new Set([...optional].filter((path) => truncated || !used.has(path)));
  for (const path of omitted) archive.remove(path);
  if (truncated)
    for (const document of documents)
      costs.set(document, scan(document, "word/document.xml", new Set(), 1, false));
  // Remove relationships too: related XML is parsed even when not rendered.
  for (const [owner, refs] of parts.relationships) {
    const ids = new Set([...refs].filter(([, path]) => omitted.has(path)).map(([id]) => id));
    if (ids.size === 0) continue;
    const relPath = owner ? owner.replace(/([^/]+)$/, "_rels/$1.rels") : "_rels/.rels";
    let xml = await archive.file(relPath)?.async("string");
    if (!xml) continue;
    const removed: { start: number; end: number }[] = [];
    const parser = xmlParser();
    let start = -1;
    parser.on("opentag", (tag) => {
      if (tag.local === "Relationship" && ids.has(tag.attributes.Id?.value ?? ""))
        start = xml!.lastIndexOf("<", parser.position - 1);
    });
    parser.on("closetag", (tag) => {
      if (tag.local === "Relationship" && start >= 0) {
        removed.push({ start, end: parser.position });
        start = -1;
      }
    });
    parser.write(xml).close();
    for (const range of removed.toReversed())
      xml = xml.slice(0, range.start) + xml.slice(range.end);
    archive.file(relPath, xml);
  }
  return { costs, truncated, omitted };
}

// Stream each entry before handing it to an engine. A tiny compressed archive
// must not turn into an unbounded allocation on the UI thread.
export async function boundedArchive(input: Extract<OfficeWorkerRequest, { type: "open" }>) {
  const { bytes } = input;
  const spreadsheet = input.kind === "xlsx";
  if (bytes.byteLength > OFFICE_PREVIEW_MAX_BYTES)
    throw new Error("Preview limited to files under 50 MB.");
  checkZipDirectory(bytes);
  const source = await JSZip.loadAsync(bytes).catch(() => {
    throw new Error("This file is damaged, encrypted, or not a valid Office document.");
  });
  const allEntries = Object.values(source.files);
  if (allEntries.length > 2048)
    throw new Error("This file contains too many archive entries to preview.");
  const entries = allEntries.filter((entry) => !entry.dir);
  if (
    input.kind === "docx" &&
    entries.some((entry) => entry.name.includes("\\") || entry.name.startsWith("/"))
  )
    throw new Error("Preview limited: this Word document has unsupported archive paths.");
  const archive = new JSZip();
  const partTypes = wordPartTypes();
  // Metadata must be bounded and classified before any payload gets a media exemption.
  if (input.kind === "docx")
    entries.sort(
      (a, b) =>
        Number(b.name === "[Content_Types].xml" || b.name.endsWith(".rels")) -
        Number(a.name === "[Content_Types].xml" || a.name.endsWith(".rels")),
    );
  const costs = new Map<string, { bytes: number; markup: number }>();
  const mediaSizes = new Map<string, number>();
  let total = 0;
  let wordAuxiliaryMarkup = 0;
  let wordInputTruncated = false;
  let word: ReturnType<typeof wordDocuments> | null = null;
  for (const entry of entries) {
    const document = input.kind === "docx" && entry.name === "word/document.xml";
    const media = input.kind === "docx" && partTypes.binary(entry.name);
    const chunks: Uint8Array[] = [];
    const sections = document ? wordSections() : null;
    let decoder: TextDecoder | undefined;
    let length = 0;
    await new Promise<void>((resolve, reject) => {
      // JSZip exposes this streaming API at runtime but omits it from its types.
      const stream = (
        entry as JSZip.JSZipObject & {
          internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
        }
      ).internalStream("uint8array");
      stream
        .on("data", (chunk: Uint8Array) => {
          total += chunk.length;
          length += chunk.length;
          if (total > (spreadsheet ? 128 * 1024 * 1024 : OFFICE_PREVIEW_MAX_BYTES)) {
            stream.pause();
            reject(new Error("The expanded document is too large to preview safely."));
            return;
          }
          try {
            if (sections) {
              decoder ??= officeXmlDecoder(chunk);
              sections.write(decoder.decode(chunk, { stream: true }));
            }
          } catch (cause) {
            stream.pause();
            reject(cause);
            return;
          }
          if (document && length > 4 * 1024 * 1024) {
            const kept = Math.max(0, chunk.length - (length - 4 * 1024 * 1024));
            if (kept) chunks.push(chunk.subarray(0, kept));
            wordInputTruncated = true;
            return;
          }
          // Media is bounded independently. Even renamed auxiliary XML must
          // stay small before the engine parses it.
          if (input.kind === "docx" && !document && !media) {
            for (const byte of chunk) if (byte === 0x3c) wordAuxiliaryMarkup++;
            if (length > 1024 * 1024 || wordAuxiliaryMarkup > 50_000) {
              stream.pause();
              reject(
                new Error("Preview limited: this Word document has too much auxiliary markup."),
              );
              return;
            }
          }
          if (
            total > (spreadsheet ? 128 * 1024 * 1024 : OFFICE_PREVIEW_MAX_BYTES) ||
            (spreadsheet && total > Math.max(bytes.byteLength * 200, 8 * 1024 * 1024)) ||
            (!document &&
              (spreadsheet || media || entry.name.endsWith(".xml")) &&
              length > (spreadsheet ? 64 * 1024 * 1024 : 8 * 1024 * 1024))
          ) {
            stream.pause();
            reject(new Error("The expanded document is too large to preview safely."));
          } else chunks.push(chunk);
        })
        .on("error", reject)
        .on("end", resolve)
        .resume();
    });
    const content = new Uint8Array(document ? Math.min(length, 4 * 1024 * 1024) : length);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.length;
    }
    if (document) {
      sections!.write(decoder?.decode() ?? "");
      word = wordDocuments(officeXml(content), wordInputTruncated, sections!.finish());
      archive.file(entry.name, word.documents[0]!);
    } else if (input.kind === "docx" && !media) {
      let xml = officeXml(content);
      if (entry.name === "[Content_Types].xml" || entry.name.endsWith(".rels"))
        xml = partTypes.metadata(entry.name, xml);
      const roles = partTypes.roles.get(entry.name);
      const cost = wordXmlCost(xml, roles);
      // The renderer parses related parts even when their render option is off.
      if (roles && [...roles].every((role) => WORD_DISABLED_PARTS.has(role))) continue;
      if (
        (roles?.has("numbering") && cost.pictures) ||
        (roles?.has("styles") &&
          (cost.bytes > WORD_STYLE_MAX_BYTES || cost.markup > WORD_STYLE_MAX_UNITS)) ||
        (roles?.has("numbering") && (cost.bytes > 128 * 1024 || cost.markup > 2_000))
      ) {
        wordInputTruncated = true;
        continue;
      }
      costs.set(entry.name, cost);
      archive.file(entry.name, xml);
    } else {
      if (input.kind === "docx" && partTypes.roles.get(entry.name)?.has("font")) {
        continue;
      }
      if (media) mediaSizes.set(entry.name, Math.ceil((content.length * 4) / 3));
      archive.file(entry.name, /\.(?:xml|rels)$/i.test(entry.name) ? officeXml(content) : content);
    }
  }
  if (word) {
    const expansion = await wordExpansion(archive, partTypes, mediaSizes, costs, word.documents);
    wordInputTruncated ||= expansion.truncated;
    for (const path of expansion.omitted) {
      archive.remove(path);
      costs.delete(path);
    }
    let mediaBytes = 0;
    const usedImages = new Set<string>();
    const auxiliary = [...costs.values()].reduce(
      (sum, cost) => ({ bytes: sum.bytes + cost.bytes, markup: sum.markup + cost.markup }),
      { bytes: 0, markup: 0 },
    );
    // The worker engine parses shared parts once, rather than once per legacy render batch.
    let bytes = auxiliary.bytes;
    let markup = auxiliary.markup;
    const documents: string[] = [];
    for (const document of word.documents) {
      const rawCost = wordXmlCost(document, undefined);
      const extra = expansion.costs.get(document)!;
      const cost = { bytes: rawCost.bytes + extra.bytes, markup: rawCost.markup + extra.markup };
      const images = extra.media;
      const batchImages = new Set(extra.images);
      if (
        bytes + cost.bytes > 3 * 1024 * 1024 ||
        markup + cost.markup > 100_000 ||
        mediaBytes + images > OFFICE_PREVIEW_MAX_BYTES
      )
        break;
      bytes += cost.bytes;
      markup += cost.markup;
      mediaBytes += images;
      for (const path of batchImages) usedImages.add(path);
      documents.push(document);
    }
    if (documents.length === 0)
      throw new Error("Preview limited: this Word document has too much expanded markup.");
    word.truncated ||= wordInputTruncated || documents.length < word.documents.length;
    word.documents = documents;
    for (const path of mediaSizes.keys()) if (!usedImages.has(path)) archive.remove(path);
    archive.file("word/document.xml", documents[0]!);
  }
  const truncatedSheets = input.kind === "xlsx" ? await boundWorkbook(archive) : [];
  return { archive, word, truncatedSheets };
}

export async function prepareOffice(
  bytes: ArrayBuffer,
  kind: Extract<OfficeWorkerRequest, { type: "open" }>["kind"],
) {
  const result = await boundedArchive({ type: "open", kind, bytes });
  const root =
    kind === "docx"
      ? "word/document.xml"
      : kind === "xlsx"
        ? "xl/workbook.xml"
        : "ppt/presentation.xml";
  if (!result.archive.file(root))
    throw new Error("This is not a valid Office Open XML file. Encrypted files are not supported.");
  if (result.word) {
    const references = new Map<string, string>();
    const relationships = xmlParser();
    relationships.on("opentag", (tag) => {
      if (tag.local !== "Relationship") return;
      const type = tag.attributes.Type?.value ?? "";
      const target = tag.attributes.Target?.value ?? "";
      const path = new URL(target, "https://docx.invalid/word/").pathname.slice(1);
      if (result.archive.file(path))
        references.set(tag.attributes.Id?.value ?? "", type.slice(type.lastIndexOf("/") + 1));
    });
    const relationshipXml = await result.archive
      .file("word/_rels/document.xml.rels")
      ?.async("string");
    if (relationshipXml) relationships.write(relationshipXml).close();
    let xml = joinWordBatches(result.word.documents);
    const removed: { start: number; end: number }[] = [];
    const parser = xmlParser();
    let start = -1;
    // Bounded parts can be omitted; dangling story references otherwise reject the entire body in the engine.
    parser.on("opentag", (tag) => {
      if (tag.local !== "headerReference" && tag.local !== "footerReference") return;
      const id = Object.values(tag.attributes).find((attr) => attr.local === "id")?.value ?? "";
      if (references.get(id) !== tag.local.replace("Reference", ""))
        start = xml.lastIndexOf("<", parser.position - 1);
    });
    parser.on("closetag", (tag) => {
      if (start >= 0 && (tag.local === "headerReference" || tag.local === "footerReference")) {
        removed.push({ start, end: parser.position });
        start = -1;
      }
    });
    parser.write(xml).close();
    for (const range of removed.toReversed())
      xml = xml.slice(0, range.start) + xml.slice(range.end);
    result.archive.file(root, xml);
  }
  return {
    bytes: await result.archive.generateAsync({ type: "arraybuffer", compression: "STORE" }),
    truncated: result.word?.truncated || result.truncatedSheets.some(Boolean) || false,
  };
}

function joinWordBatches(documents: string[]) {
  let prefix = "";
  let suffix = "";
  let section = "";
  const bodies: string[] = [];
  for (const xml of documents) {
    const parser = xmlParser();
    let depth = 0;
    let start = 0;
    let end = 0;
    let sectionStart = 0;
    parser.on("opentag", (tag) => {
      depth++;
      if (depth === 2 && tag.local === "body") {
        start = parser.position;
        if (!prefix) prefix = xml.slice(0, start);
      }
      if (depth === 3 && tag.local === "sectPr")
        sectionStart = xml.lastIndexOf("<", parser.position - 1);
    });
    parser.on("closetag", (tag) => {
      if (depth === 2 && tag.local === "body") {
        end = xml.lastIndexOf("<", parser.position - 1);
        suffix = xml.slice(end);
      }
      depth--;
    });
    parser.write(xml).close();
    bodies.push(xml.slice(start, sectionStart || end));
    section = sectionStart ? xml.slice(sectionStart, end) : "";
  }
  return prefix + bodies.join("") + section + suffix;
}
