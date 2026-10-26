import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { decodeHTMLAttribute, decodeHTMLStrict as decodeEntities } from "entities";
import type JSZip from "jszip";

import { type OfficeWorkerResult, type NotebookCell } from "./officePreviewProtocol";

const ODS_PREVIEW_MAX_ROWS = 500;
const ODS_PREVIEW_MAX_COLUMNS = 50;

type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };
type OrderedXml = { [key: string]: OrderedXml[] | Record<string, string> | string };
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const namespacePrefixes: Record<string, string> = {
  "urn:oasis:names:tc:opendocument:xmlns:office:1.0": "office",
  "urn:oasis:names:tc:opendocument:xmlns:table:1.0": "table",
  "urn:oasis:names:tc:opendocument:xmlns:text:1.0": "text",
  "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0": "draw",
  "http://www.w3.org/1999/xlink": "xlink",
  "http://www.w3.org/1999/xhtml": "",
  "http://www.idpf.org/2007/opf": "",
  "urn:oasis:names:tc:opendocument:xmlns:container": "",
};
function parseXml(source: string): XmlNode {
  // EPUB XHTML commonly declares an external DTD. Discard it without resolving it.
  source = source.replaceAll(/<!DOCTYPE\s+[^<>[\]]*>/gi, "");
  if (
    source.length > 8 * 1024 * 1024 ||
    /<!\s*(DOCTYPE|ENTITY)/i.test(source) ||
    XMLValidator.validate(source) !== true
  )
    throw new Error("This document contains invalid or unsupported XML.");
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "",
    processEntities: false,
    trimValues: false,
    parseTagValue: false,
  });
  const ordered = parser.parse(source) as OrderedXml[];
  let count = 0;
  function convert(
    items: OrderedXml[],
    depth: number,
    inherited: Record<string, string>,
  ): XmlNode[] {
    if (depth > 100) throw new Error("This document is nested too deeply to preview.");
    return items.map((item) => {
      if (++count > 100_000) throw new Error("This document has too much content to preview.");
      const name = Object.keys(item).find((key) => key !== ":@") ?? "#text";
      const value = item[name];
      const attrs = Object.fromEntries(
        Object.entries((item[":@"] ?? {}) as Record<string, string>).map(([key, value]) => [
          key,
          decodeEntities(value),
        ]),
      );
      const namespaces = Object.create(inherited) as Record<string, string>;
      for (const [key, value] of Object.entries(attrs)) {
        if (key === "xmlns") namespaces[""] = value;
        else if (key.startsWith("xmlns:")) namespaces[key.slice(6)] = value;
      }
      const expanded = (name: string, attribute = false) => {
        if (name.startsWith("#")) return name;
        const colon = name.indexOf(":");
        if (colon < 0 && attribute) return name;
        const uri = namespaces[colon < 0 ? "" : name.slice(0, colon)];
        if (!uri) return name;
        const prefix = Object.hasOwn(namespacePrefixes, uri) ? namespacePrefixes[uri] : undefined;
        const local = name.slice(colon + 1);
        return prefix === undefined
          ? "{" + uri + "}" + local
          : prefix
            ? prefix + ":" + local
            : local;
      };
      return {
        name: expanded(name),
        attrs: Object.fromEntries(
          Object.entries(attrs).map(([key, value]) => [expanded(key, true), value]),
        ),
        children: Array.isArray(value) ? convert(value, depth + 1, namespaces) : [],
        text: typeof value === "string" ? value : "",
      };
    });
  }
  return {
    name: "root",
    attrs: {},
    children: convert(ordered, 0, Object.create(null) as Record<string, string>),
    text: "",
  };
}
function find(node: XmlNode, name: string, skip?: string): XmlNode[] {
  return node.children.flatMap((child) =>
    child.name === skip
      ? []
      : child.name === name || (!name.includes(":") && child.name.endsWith(`:${name}`))
        ? [child]
        : find(child, name, skip),
  );
}
function text(node: XmlNode): string {
  if (node.name === "office:annotation") return "";
  if (node.name === "text:s") return " ".repeat(repeat(node.attrs["text:c"], 100));
  if (node.name === "text:tab") return "\t";
  if (node.name === "text:line-break") return "\n";
  return node.name === "#text" ? decodeEntities(node.text) : node.children.map(text).join("");
}
function archivePath(base: string, href: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(href)) return null;
  const parts = base.split("/").slice(0, -1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? "");
  } catch {
    return null;
  }
  for (const part of decoded.split("/")) {
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
function imageFits(bytes: Uint8Array) {
  const size = readImageDimensions(bytes.subarray(0, IMAGE_DIMENSIONS_HEADER_BYTES));
  return size !== null && size.width <= 16_777_216 / size.height;
}
function base64ImageFits(base64: string) {
  return (
    /^[a-z\d+/]*={0,2}$/i.test(base64) &&
    base64.length % 4 !== 1 &&
    (!base64.endsWith("=") || base64.length % 4 === 0) &&
    imageFits(
      Uint8Array.from(
        atob(base64.slice(0, 4 * Math.ceil(IMAGE_DIMENSIONS_HEADER_BYTES / 3))),
        (char) => char.charCodeAt(0),
      ),
    )
  );
}
function htmlImagesFit(html: string) {
  // HTML attribute entities can obscure a data URL until the client parses it.
  for (const match of decodeHTMLAttribute(html).matchAll(
    /data:image\/(?:png|jpeg|gif|webp);base64,([a-z\d+/]*={0,2})/gi,
  ))
    if (!base64ImageFits(match[1]!)) return false;
  return true;
}
async function imageData(archive: JSZip, path: string | null): Promise<string> {
  if (!path) return "";
  const mime = (
    { png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp" } as Record<string, string>
  )[path.split(".").at(-1)?.toLowerCase() ?? ""];
  const entry = archive.file(path);
  if (!mime || !entry) return "";
  const bytes = await entry.async("uint8array");
  if (bytes.length > 4 * 1024 * 1024 || !imageFits(bytes)) return "";
  reserveMarkup(4 * Math.ceil(bytes.length / 3) + 100);
  return `data:image/${mime};base64,${await entry.async("base64")}`;
}
let markupBytes = 0;
function reserveMarkup(size: number) {
  markupBytes += size;
  if (markupBytes > 16 * 1024 * 1024)
    throw new Error("The rendered document is too large to preview.");
}
function boundedMarkup(value: string): string {
  reserveMarkup(value.length);
  return value;
}
const HTML_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "div",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "caption",
  "figure",
  "figcaption",
  "br",
  "hr",
  "sub",
  "sup",
  "dl",
  "dt",
  "dd",
]);
async function epubHtml(node: XmlNode, archive: JSZip, base: string): Promise<string> {
  if (node.name === "#text") return boundedMarkup(escape(text(node)));
  const tag =
    node.name
      .replace(/^\{[^}]*\}/, "")
      .split(":")
      .at(-1) ?? "";
  if (["head", "script", "style", "iframe", "object", "embed", "svg", "math", "form"].includes(tag))
    return "";
  if (tag === "br" || tag === "hr") return boundedMarkup(`<${tag}>`);
  if (tag === "img") {
    const src = await imageData(archive, archivePath(base, node.attrs.src ?? ""));
    return src ? `<img src="${src}" alt="${boundedMarkup(escape(node.attrs.alt ?? ""))}">` : "";
  }
  let children = "";
  for (const child of node.children) children += await epubHtml(child, archive, base);
  if (!HTML_TAGS.has(tag)) return children;
  const spans =
    tag === "td" || tag === "th"
      ? ["colspan", "rowspan"]
          .map((name) =>
            /^\d{1,4}$/.test(node.attrs[name] ?? "") ? ` ${name}="${node.attrs[name]}"` : "",
          )
          .join("")
      : "";
  reserveMarkup(tag.length * 2 + spans.length + 5);
  return `<${tag}${spans}>${children}</${tag}>`;
}
async function odfHtml(node: XmlNode, archive: JSZip): Promise<string> {
  if (node.name === "#text") return boundedMarkup(escape(text(node)));
  if (node.name === "text:s" || node.name === "text:tab")
    return boundedMarkup(
      `<span data-odf-whitespace>${node.name === "text:tab" ? "&#9;" : " ".repeat(repeat(node.attrs["text:c"], 100))}</span>`,
    );
  if (node.name === "text:line-break") return boundedMarkup("<br>");
  if (node.name === "draw:image") {
    const src = await imageData(
      archive,
      archivePath("content.xml", node.attrs["xlink:href"] ?? ""),
    );
    return src ? `<img src="${src}" alt="">` : "";
  }
  if (
    [
      "office:annotation",
      "text:tracked-changes",
      "office:scripts",
      "draw:object",
      "draw:object-ole",
    ].includes(node.name)
  )
    return "";
  let children = "";
  for (const child of node.children) children += await odfHtml(child, archive);
  const tags: Record<string, string> = {
    "text:p": "p",
    "text:h": "h2",
    "text:span": "span",
    "text:list": "ul",
    "text:list-item": "li",
    "table:table": "table",
    "table:table-row": "tr",
    "table:table-cell": "td",
  };
  const tag = tags[node.name];
  if (!tag) return children;
  reserveMarkup(tag.length * 2 + 5);
  return `<${tag}>${children}</${tag}>`;
}
function repeat(value: string | undefined, max: number) {
  const count = Number(value ?? 1);
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error("This spreadsheet contains invalid repeated cells.");
  return Math.min(count, max);
}
export async function openDocument(
  archive: JSZip,
  kind: "odt" | "ods" | "odp",
): Promise<OfficeWorkerResult> {
  markupBytes = 0;
  const source = await archive.file("content.xml")?.async("string");
  if (!source) throw new Error("This OpenDocument file has no readable content.");
  const root = parseXml(source);
  if (kind === "ods") {
    const tables = find(root, "table:table");
    if (!tables.length || tables.length > 100)
      throw new Error("This workbook has no sheets or too many sheets to preview.");
    let cellBytes = 0;
    return {
      type: "ods",
      sheets: tables.map((table, index) => {
        const rows: string[][] = [];
        let truncated = false;
        let pendingEmptyRows = 0;
        for (const row of find(table, "table:table-row")) {
          const cells: string[] = [];
          for (const cell of row.children.filter((child) =>
            ["table:table-cell", "table:covered-table-cell"].includes(child.name),
          )) {
            const value =
              find(cell, "text:p", "office:annotation").map(text).join("\n") ||
              cell.attrs["office:value"] ||
              cell.attrs["office:date-value"] ||
              cell.attrs["office:boolean-value"] ||
              cell.attrs["office:string-value"] ||
              "";
            const count = repeat(
              cell.attrs["table:number-columns-repeated"],
              ODS_PREVIEW_MAX_COLUMNS + 1,
            );
            if (value && cells.length + count > ODS_PREVIEW_MAX_COLUMNS) truncated = true;
            for (let i = 0; i < count && cells.length < ODS_PREVIEW_MAX_COLUMNS; i++) {
              if (value.length > 10_000)
                throw new Error("A spreadsheet cell is too large to preview.");
              cells.push(value);
            }
          }
          while (cells.at(-1) === "") cells.pop();
          const count = repeat(row.attrs["table:number-rows-repeated"], ODS_PREVIEW_MAX_ROWS + 1);
          if (!cells.length) {
            pendingEmptyRows = Math.min(ODS_PREVIEW_MAX_ROWS + 1, pendingEmptyRows + count);
            continue;
          }
          while (pendingEmptyRows > 0 && rows.length < ODS_PREVIEW_MAX_ROWS) {
            rows.push([]);
            pendingEmptyRows--;
          }
          pendingEmptyRows = 0;
          if (rows.length + count > ODS_PREVIEW_MAX_ROWS) truncated = true;
          if (rows.length >= ODS_PREVIEW_MAX_ROWS) break;
          for (let i = 0; i < count && rows.length < ODS_PREVIEW_MAX_ROWS; i++) {
            cellBytes += cells.reduce((size, cell) => size + cell.length, 0);
            if (cellBytes > 8 * 1024 * 1024)
              throw new Error("This spreadsheet has too much text to preview.");
            rows.push(cells);
          }
        }
        return {
          name: table.attrs["table:name"] || `Sheet ${index + 1}`,
          rows,
          rowCount: rows.length,
          columns: rows.reduce((columns, row) => Math.max(columns, row.length), 1),
          truncated,
        };
      }),
    };
  }
  const pages = kind === "odp" ? find(root, "draw:page") : find(root, "office:text");
  if (!pages.length || pages.length > 500)
    throw new Error("This document has no pages or too many pages to preview.");
  const rendered = [];
  for (const [index, page] of pages.entries()) {
    rendered.push({
      title: page.attrs["draw:name"] || `Page ${index + 1}`,
      html: await odfHtml(page, archive),
    });
  }
  return { type: "document", navigation: kind === "odp" ? "slide" : "page", pages: rendered };
}
export async function openEpub(archive: JSZip): Promise<OfficeWorkerResult> {
  markupBytes = 0;
  const container = parseXml((await archive.file("META-INF/container.xml")?.async("string")) ?? "");
  const rootfile = find(container, "rootfile")[0]?.attrs["full-path"];
  if (!rootfile || !archive.file(rootfile)) throw new Error("This EPUB has no readable package.");
  const packageRoot = parseXml(await archive.file(rootfile)!.async("string"));
  const manifest = new Map(find(packageRoot, "item").map((item) => [item.attrs.id, item]));
  const spine = find(packageRoot, "itemref");
  if (!spine.length || spine.length > 500)
    throw new Error("This EPUB has no chapters or too many chapters to preview.");
  const pages = [];
  for (const itemref of spine) {
    const item = manifest.get(itemref.attrs.idref);
    if (!item || item.attrs["media-type"] !== "application/xhtml+xml") continue;
    const path = archivePath(rootfile, item.attrs.href ?? "");
    const entry = path ? archive.file(path) : null;
    if (!entry || !path) continue;
    const chapter = parseXml(await entry.async("string"));
    pages.push({
      title:
        text(find(chapter, "title")[0] ?? find(chapter, "h1")[0] ?? chapter).slice(0, 120) ||
        `Chapter ${pages.length + 1}`,
      html: await epubHtml(chapter, archive, path),
    });
  }
  if (!pages.length) throw new Error("This EPUB has no readable XHTML chapters.");
  return { type: "document", navigation: "chapter", pages };
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function notebookText(value: unknown, limit = 256_000): string {
  const result =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.filter((part) => typeof part === "string").join("")
        : "";
  if (result.length > limit) throw new Error("A notebook cell is too large to preview.");
  return result;
}
export function openNotebook(bytes: ArrayBuffer): OfficeWorkerResult {
  if (bytes.byteLength > 8 * 1024 * 1024)
    throw new Error("Notebook preview limited to files under 8 MB.");
  const notebook = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells) || notebook.cells.length > 500)
    throw new Error("Preview supports version 4 notebooks with up to 500 cells.");
  const language = String(record(record(notebook.metadata).language_info).name ?? "text")
    .replaceAll(/[^a-z\d+#-]/gi, "")
    .slice(0, 40);
  const cells: NotebookCell[] = notebook.cells.map((value) => {
    const cell = record(value);
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    if (outputs.length > 100) throw new Error("A notebook cell has too many outputs to preview.");
    return {
      kind: cell.cell_type === "markdown" ? "markdown" : cell.cell_type === "code" ? "code" : "raw",
      source: notebookText(cell.source),
      outputs: outputs
        .map((value) => {
          const output = record(value);
          const data = record(output.data);
          for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
            if (data[mime]) {
              const base64 = notebookText(data[mime], 4 * 1024 * 1024).replaceAll(/\s/g, "");
              if (base64ImageFits(base64))
                return { kind: "image" as const, text: `data:${mime};base64,${base64}` };
            }
          }
          const html = notebookText(data["text/html"]);
          if (html.trim() && htmlImagesFit(html)) return { kind: "html" as const, text: html };
          return {
            kind: "text" as const,
            text: notebookText(output.text ?? data["text/plain"] ?? output.traceback),
          };
        })
        .filter((output) => output.text.trim().length > 0),
    };
  });
  return { type: "notebook", language, cells };
}

export function openRtf(bytes: ArrayBuffer): OfficeWorkerResult {
  if (bytes.byteLength > 8 * 1024 * 1024)
    throw new Error("Rich text preview limited to files under 8 MB.");
  // Keep byte offsets intact for binary destinations and multibyte code pages.
  const input = new Uint8Array(bytes);
  let source = "";
  for (let offset = 0; offset < input.length; offset += 8192)
    source += String.fromCharCode(...input.subarray(offset, offset + 8192));
  if (!source.startsWith("{\\rtf")) throw new Error("This is not a valid rich text document.");
  let state = {
    skip: false,
    bold: false,
    italic: false,
    underline: false,
    uc: 1,
    font: 0,
    fontTable: false,
    decoder: new TextDecoder("windows-1252"),
  };
  const fonts = new Map<number, TextDecoder>();
  let defaultFont = 0;
  const stack: (typeof state)[] = [];
  let html = "";
  const pages: { title: string; html: string }[] = [];
  let completedLength = 0;
  const finishPage = () => {
    if (pages.length >= 500) throw new Error("Rich text preview limited to 500 pages.");
    pages.push({ title: `Page ${pages.length + 1}`, html: `<p>${html}</p>` });
    completedLength += html.length;
    html = "";
  };
  let run = "";
  let fallback = 0;
  const encoded = new Uint8Array(bytes.byteLength);
  let encodedLength = 0;
  const flush = () => {
    if (encodedLength) {
      run += escape(
        (fonts.get(state.font) ?? state.decoder).decode(encoded.subarray(0, encodedLength)),
      );
      encodedLength = 0;
    }
    if (completedLength + html.length + run.length > 8 * 1024 * 1024)
      throw new Error("This rich text document has too much content to preview.");
    if (!run) return;
    let span = run;
    if (state.bold) span = `<strong>${span}</strong>`;
    if (state.italic) span = `<em>${span}</em>`;
    if (state.underline) span = `<u>${span}</u>`;
    html += span;
    run = "";
  };
  const emit = (value: string) => {
    if (fallback > 0) {
      fallback--;
      return;
    }
    if (state.skip) return;
    run += escape(value);
    if (completedLength + html.length + run.length > 8 * 1024 * 1024)
      throw new Error("This rich text document has too much content to preview.");
  };
  const emitByte = (value: number) => {
    if (fallback > 0) fallback--;
    else if (!state.skip) encoded[encodedLength++] = value;
  };
  for (let i = 0; i < source.length;) {
    const char = source[i++];
    if (char === "{") {
      flush();
      fallback = 0;
      if (stack.length > 100) throw new Error("This rich text document is nested too deeply.");
      stack.push({ ...state });
    } else if (char === "}") {
      flush();
      fallback = 0;
      const parent = stack.pop();
      if (!parent) throw new Error("This rich text document is damaged.");
      state = parent;
    } else if (char === "\\") {
      const next = source[i];
      if (next === "'") {
        const hex = source.slice(i + 1, i + 3);
        if (!/^[\da-f]{2}$/i.test(hex)) throw new Error("Invalid rich text byte escape.");
        i += 3;
        emitByte(Number.parseInt(hex, 16));
        continue;
      }
      flush();
      if (next === "\\" || next === "{" || next === "}") {
        i++;
        emit(next);
        continue;
      }
      if (next === "*") {
        state.skip = true;
        i++;
        continue;
      }
      const match = /^([a-z]+)(-?\d+)? ?/i.exec(source.slice(i));
      if (!match) {
        if (next === "~") emit("\u00a0");
        i++;
        continue;
      }
      i += match[0].length;
      const word = match[1];
      const arg = match[2] === undefined ? 1 : Number(match[2]);
      if (word === "fonttbl") {
        state.fontTable = true;
        state.skip = true;
      } else if (word === "deff") state.font = defaultFont = arg;
      else if (word === "f") state.font = arg;
      else if (word === "fcharset" && state.fontTable) {
        const label = (
          {
            0: state.decoder.encoding,
            1: state.decoder.encoding,
            77: "macintosh",
            128: "shift_jis",
            129: "euc-kr",
            134: "gbk",
            136: "big5",
            161: "windows-1253",
            162: "windows-1254",
            163: "windows-1258",
            177: "windows-1255",
            178: "windows-1256",
            186: "windows-1257",
            204: "windows-1251",
            222: "windows-874",
            238: "windows-1250",
            255: "ibm866",
          } as Record<number, string>
        )[arg];
        if (label) fonts.set(state.font, new TextDecoder(label));
      } else if (
        [
          "colortbl",
          "stylesheet",
          "info",
          "pict",
          "object",
          "fldinst",
          "header",
          "headerl",
          "headerr",
          "headerf",
          "footer",
          "footerl",
          "footerr",
          "footerf",
          "filetbl",
          "datastore",
          "themedata",
        ].includes(word!)
      )
        state.skip = true;
      else if (word === "bin") {
        if (!Number.isSafeInteger(arg) || arg < 0 || arg > source.length - i)
          throw new Error("Invalid rich text binary data.");
        i += arg;
      } else if (word === "ansicpg") {
        const label =
          (
            {
              65001: "utf-8",
              932: "shift_jis",
              936: "gbk",
              949: "euc-kr",
              950: "big5",
              874: "windows-874",
            } as Record<number, string>
          )[arg] ?? `windows-${arg}`;
        try {
          state.decoder = new TextDecoder(label);
        } catch {
          throw new Error("This rich text code page is not supported.");
        }
      } else if (word === "b") state.bold = arg !== 0;
      else if (word === "i") state.italic = arg !== 0;
      else if (word === "ul") state.underline = arg !== 0;
      else if (word === "ulnone") state.underline = false;
      else if (word === "plain")
        state = { ...state, bold: false, italic: false, underline: false, font: defaultFont };
      else if (word === "uc") state.uc = Math.max(0, Math.min(10, arg));
      else if (word === "u") {
        fallback = 0;
        emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
        fallback = state.uc;
      } else if (!state.skip && word === "page") finishPage();
      else if (!state.skip && (word === "par" || word === "line" || word === "row")) html += "<br>";
      else if (word === "tab" || word === "cell") emit("\t");
      else if (word === "endash") emit("–");
      // oxlint-disable-next-line t3code/no-em-dash-copy -- Preserve the RTF document's punctuation.
      else if (word === "emdash") emit("—");
      else if (word === "bullet") emit("•");
      else if (word === "lquote") emit("‘");
      else if (word === "rquote") emit("’");
      else if (word === "ldblquote") emit("“");
      else if (word === "rdblquote") emit("”");
    } else if (char !== "\r" && char !== "\n" && char) emitByte(char.charCodeAt(0));
  }
  if (stack.length) throw new Error("This rich text document is damaged.");
  flush();
  if (html || !pages.length) finishPage();
  return { type: "document", navigation: "page", pages };
}
