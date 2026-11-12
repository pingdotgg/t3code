import JSZip from "jszip";
import { SaxesParser } from "saxes";
import { externalUrl } from "./office/links";
import {
  OFFICE_PREVIEW_MAX_BYTES,
  OFFICE_PREVIEW_MAX_COLUMNS,
  OFFICE_PREVIEW_MAX_ROWS,
  type OfficeWorkerRequest,
} from "./officePreviewProtocol";

export function xmlParser() {
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    throw new Error("This document contains unsupported XML declarations.");
  });
  return parser;
}

export function officeXmlDecoder(bytes: Uint8Array) {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0))
    return new TextDecoder("utf-16le");
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c))
    return new TextDecoder("utf-16be");
  const declaration = new TextDecoder().decode(bytes.subarray(0, 256));
  return new TextDecoder(/^<\?xml\s[^?]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(declaration)?.[1]);
}

export function officeXml(bytes: Uint8Array) {
  // Repacked XML is UTF-8, regardless of the source part's encoding.
  return officeXmlDecoder(bytes)
    .decode(bytes)
    .replace(/^(<\?xml\s[^?]*\bencoding\s*=\s*)["'][^"']+["']/i, '$1"UTF-8"');
}

// Section properties terminate the section they describe, so the kept prefix
// may depend on a paragraph or body section beyond the retained input window.
export function wordSections() {
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
export function wordDocuments(
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

export function boundedWorksheet(
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

export async function boundWorkbook(archive: JSZip) {
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

export const WORD_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
export const WORD_EXPANDED_PARTS = new Set(["footnotes", "endnotes", "comments", "header", "footer"]);
export const WORD_DISABLED_PARTS = new Set(["commentsExtended", "fontTable", "aFChunk"]);
export const WORD_BINARY_PARTS = new Set([
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

export function wordPartTypes() {
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
