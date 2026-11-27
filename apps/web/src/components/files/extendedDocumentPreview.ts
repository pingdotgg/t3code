import { pipe } from "effect/Function";
import { IMAGE_DIMENSIONS_HEADER_BYTES } from "@t3tools/shared/imageDimensions";
import { decodeHTMLAttribute } from "entities";
import type JSZip from "jszip";
import {
  terminalOutputCollapseRedraws,
  terminalOutputPlainText,
} from "@t3tools/shared/terminalOutput";

import { type OfficeWorkerResult, type NotebookCell } from "./officePreviewProtocol";
import { isPreviewError, PreviewError } from "./previewFailure";
import { officeXmlDecoder } from "./officeArchive";
import {
  archivePath,
  escape,
  find,
  imageFits,
  parseXml,
  repeat,
  text,
  type XmlNode,
} from "./documentPreviewXml";

const TABLE_PREVIEW_MAX_ROWS = 500;
const TABLE_PREVIEW_MAX_COLUMNS = 50;

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
    /(?<=[\t\n\f\r "'/])src[\t\n\f\r ]*=[\t\n\f\r ]*(["'])[\t\n\f\r ]*data:image\/(?:png|jpeg|gif|webp);base64,([a-z\d+/\t\n\f\r ]*(?:=[\t\n\f\r ]*){0,2})\1|data:image\/(?:png|jpeg|gif|webp);base64,([a-z\d+/]*={0,2})/gi,
  ))
    if (!base64ImageFits(match[2]?.replaceAll(/[\t\n\f\r ]/g, "") ?? match[3]!)) return false;
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
  if (markupBytes > 16 * 1024 * 1024) throw new PreviewError({ code: "rendered-too-large" });
}
function boundedMarkup(value: string): string {
  reserveMarkup(value.length);
  return value;
}
async function odfHtml(
  node: XmlNode,
  archive: JSZip,
  listStyles: Map<string, XmlNode>,
  imageAlt = "",
  inRepeatedRow = false,
  list: [string, number] = ["", 0],
): Promise<string> {
  if (node.name === "#text") return pipe(text(node), escape, boundedMarkup);
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
    return src ? `<img src="${src}" alt="${boundedMarkup(escape(imageAlt))}">` : "";
  }
  if (
    [
      "office:annotation",
      "presentation:notes",
      "svg:title",
      "svg:desc",
      "text:tracked-changes",
      "office:scripts",
      "draw:object",
      "draw:object-ole",
      "text:table-of-content-source",
      "text:illustration-index-source",
      "text:table-index-source",
      "text:object-index-source",
      "text:user-index-source",
      "text:alphabetical-index-source",
      "text:bibliography-source",
      "table:covered-table-cell",
    ].includes(node.name)
  )
    return "";
  const childImageAlt =
    node.name === "draw:frame"
      ? ["svg:title", "svg:desc"]
          .map((name) => node.children.find((child) => child.name === name))
          .map((child) => (child ? text(child).trim() : ""))
          .filter(Boolean)
          .join(" ")
      : "";
  let children = "";
  const repeatedRow =
    node.name === "table:table-row"
      ? Number(node.attrs["table:number-rows-repeated"]) > 1
      : inRepeatedRow;
  // Sub-lists nest directly in list items; a list in a table cell, frame or note restarts at level 1.
  const nextList: [string, number] =
    node.name === "text:list"
      ? [node.attrs["text:style-name"] || list[0], list[1] + 1]
      : node.name === "text:list-item" || node.name === "text:list-header"
        ? list
        : ["", 0];
  for (const child of node.children)
    children += await odfHtml(child, archive, listStyles, childImageAlt, repeatedRow, nextList);
  const numbered =
    node.name === "text:list" &&
    listStyles
      .get(nextList[0])
      ?.children.some(
        (level) =>
          level.name === "text:list-level-style-number" &&
          level.attrs["text:level"] === String(nextList[1]) &&
          !!level.attrs["style:num-format"],
      );
  const tags: Record<string, string> = {
    "text:p": "p",
    "text:h": "h2",
    "text:span": "span",
    "text:list": numbered ? "ol" : "ul",
    "text:list-item": "li",
    "table:table": "table",
    "table:table-row": "tr",
    "table:table-cell": "td",
  };
  const level = node.name === "text:h" ? Number(node.attrs["text:outline-level"]) : NaN;
  const tag =
    Number.isSafeInteger(level) && level >= 1 ? `h${Math.min(level, 6)}` : tags[node.name];
  if (!tag) return children;
  const count =
    tag === "tr"
      ? repeat(node.attrs["table:number-rows-repeated"], TABLE_PREVIEW_MAX_ROWS)
      : tag === "td"
        ? repeat(node.attrs["table:number-columns-repeated"], TABLE_PREVIEW_MAX_COLUMNS)
        : 1;
  let spans = "";
  // Spans on repeated cells or rows would multiply past the preview's table limits.
  if (tag === "td" && count === 1)
    for (const [name, attr, max] of [
      ["colspan", "table:number-columns-spanned", TABLE_PREVIEW_MAX_COLUMNS],
      ["rowspan", "table:number-rows-spanned", repeatedRow ? 1 : TABLE_PREVIEW_MAX_ROWS],
    ] as const) {
      const span = Number(node.attrs[attr]);
      if (max > 1 && Number.isSafeInteger(span) && span > 1)
        spans += ` ${name}="${Math.min(span, max)}"`;
    }
  const markup = `<${tag}${spans}>${children}</${tag}>`;
  reserveMarkup(count * markup.length - children.length);
  return markup.repeat(count);
}
export async function openDocument(
  archive: JSZip,
  kind: "odt" | "ods" | "odp",
): Promise<OfficeWorkerResult> {
  markupBytes = 0;
  const content = await archive.file("content.xml")?.async("uint8array");
  if (!content?.length) throw new PreviewError({ code: "odf-no-content" });
  const root = parseXml(officeXmlDecoder(content).decode(content));
  if (kind === "ods") {
    const tables = find(root, "table:table");
    if (!tables.length || tables.length > 100) throw new PreviewError({ code: "ods-sheet-count" });
    let cellBytes = 0;
    return {
      type: "ods",
      sheets: tables.map((table) => {
        const rows: string[][] = [];
        let truncated = false;
        let pendingEmptyRows = 0;
        for (const row of find(table, "table:table-row")) {
          const cells: string[] = [];
          for (const cell of row.children.filter((child) =>
            ["table:table-cell", "table:covered-table-cell"].includes(child.name),
          )) {
            const value =
              cell.name === "table:covered-table-cell"
                ? ""
                : find(cell, "text:p", "office:annotation").map(text).join("\n") ||
                  cell.attrs["office:value"] ||
                  cell.attrs["office:date-value"] ||
                  cell.attrs["office:time-value"] ||
                  cell.attrs["office:boolean-value"] ||
                  cell.attrs["office:string-value"] ||
                  "";
            const count = repeat(
              cell.attrs["table:number-columns-repeated"],
              TABLE_PREVIEW_MAX_COLUMNS + 1,
            );
            if (value && cells.length + count > TABLE_PREVIEW_MAX_COLUMNS) truncated = true;
            for (let i = 0; i < count && cells.length < TABLE_PREVIEW_MAX_COLUMNS; i++) {
              if (value.length > 10_000) throw new PreviewError({ code: "ods-cell-too-large" });
              cells.push(value);
            }
          }
          while (cells.at(-1) === "") cells.pop();
          const count = repeat(row.attrs["table:number-rows-repeated"], TABLE_PREVIEW_MAX_ROWS + 1);
          if (!cells.length) {
            pendingEmptyRows = Math.min(TABLE_PREVIEW_MAX_ROWS + 1, pendingEmptyRows + count);
            continue;
          }
          while (pendingEmptyRows > 0 && rows.length < TABLE_PREVIEW_MAX_ROWS) {
            rows.push([]);
            pendingEmptyRows--;
          }
          pendingEmptyRows = 0;
          if (rows.length + count > TABLE_PREVIEW_MAX_ROWS) truncated = true;
          if (rows.length >= TABLE_PREVIEW_MAX_ROWS) break;
          for (let i = 0; i < count && rows.length < TABLE_PREVIEW_MAX_ROWS; i++) {
            cellBytes += cells.reduce((size, cell) => size + cell.length, 0);
            if (cellBytes > 8 * 1024 * 1024) throw new PreviewError({ code: "ods-too-much-text" });
            rows.push(cells);
          }
        }
        return {
          name: table.attrs["table:name"] || undefined,
          rows,
          rowCount: rows.length,
          columns: rows.length && rows.reduce((columns, row) => Math.max(columns, row.length), 1),
          truncated,
        };
      }),
    };
  }
  const pages = kind === "odp" ? find(root, "draw:page") : find(root, "office:text");
  if (!pages.length || pages.length > 500) throw new PreviewError({ code: "odf-page-count" });
  const listStyles = new Map<string, XmlNode>();
  if (find(root, "text:list").length) {
    // Named list styles live in styles.xml; it only decides numbering, so a bad part falls back to bullets.
    let named: XmlNode[] = [];
    const styles = await archive.file("styles.xml")?.async("uint8array");
    try {
      if (styles?.length)
        named = find(parseXml(officeXmlDecoder(styles).decode(styles)), "office:styles");
    } catch (cause) {
      if (!isPreviewError(cause) && !(cause instanceof RangeError)) throw cause;
    }
    for (const style of [...named, root].flatMap((part) =>
      find(part, "text:list-style", "office:body"),
    ))
      if (style.attrs["style:name"]) listStyles.set(style.attrs["style:name"], style);
  }
  const rendered = [];
  for (const page of pages) {
    rendered.push({
      title: page.attrs["draw:name"] || undefined,
      html: await odfHtml(page, archive, listStyles),
    });
  }
  return { type: "document", navigation: kind === "odp" ? "slide" : "page", pages: rendered };
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
  if (result.length > limit) throw new PreviewError({ code: "notebook-cell-too-large" });
  return result;
}
// IPython traceback frames carry ANSI SGR colors and may omit a final newline.
function tracebackLines(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const frames = value
    .filter((frame): frame is string => typeof frame === "string")
    .map(terminalOutputPlainText);
  return frames.map((frame, index) =>
    index && !frames[index - 1]!.endsWith("\n") ? `\n${frame}` : frame,
  );
}
export function openNotebook(bytes: ArrayBuffer): OfficeWorkerResult {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new PreviewError({ code: "notebook-too-large" });
  const notebook = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells) || notebook.cells.length > 500)
    throw new PreviewError({ code: "notebook-unsupported" });
  const metadata = record(notebook.metadata);
  const language =
    String(record(metadata.language_info).name || record(metadata.kernelspec).language || "")
      .replaceAll(/[^a-z\d+#-]/gi, "")
      .slice(0, 40) || "text";
  const cells: NotebookCell[] = notebook.cells.map((value) => {
    const cell = record(value);
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    if (outputs.length > 100) throw new PreviewError({ code: "notebook-too-many-outputs" });
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
          const plain = terminalOutputPlainText(
            notebookText(
              output.text ??
                data["text/plain"] ??
                data["text/markdown"] ??
                tracebackLines(output.traceback),
            ),
          );
          const text =
            output.output_type === "stream" ? terminalOutputCollapseRedraws(plain) : plain;
          if (text.trim() || output.output_type !== "error") return { kind: "text" as const, text };
          const summary = [output.ename, output.evalue]
            .filter((part) => typeof part === "string")
            .map((part) => terminalOutputPlainText(notebookText(part)))
            .filter((part) => part.trim().length > 0)
            .join(": ");
          return { kind: "text" as const, text: summary };
        })
        .filter((output) => output.text.trim().length > 0),
    };
  });
  return { type: "notebook", language, cells };
}

// Characters RTF writes as control symbols (`\~`) and control words (`\emspace`).
const RTF_CHARACTERS = new Map([
  ["~", "\u00a0"],
  ["_", "\u2011"],
  ["-", "\u00ad"],
  ["tab", "\t"],
  ["endash", "–"],
  // oxlint-disable-next-line t3code/no-em-dash-copy -- Preserve the RTF document's punctuation.
  ["emdash", "—"],
  ["bullet", "•"],
  ["lquote", "‘"],
  ["rquote", "’"],
  ["ldblquote", "“"],
  ["rdblquote", "”"],
  ["enspace", "\u2002"],
  ["emspace", "\u2003"],
  ["qmspace", "\u2005"],
  ["zwbo", "\u200b"],
  ["zwnj", "\u200c"],
  ["zwj", "\u200d"],
  ["ltrmark", "\u200e"],
  ["rtlmark", "\u200f"],
]);

const RTF_UNDERLINE_WORD =
  /^(?:ul|uld|uldash|uldashd|uldashdd|uldb|ulhair|ulhwave|ulldash|ulth|ulthd|ulthdash|ulthdashd|ulthdashdd|ulthldash|ululdbwave|ulw|ulwave)$/;

const rtfCodePageLabel = (codePage: number) =>
  (
    {
      0: "windows-1252",
      866: "ibm866",
      65001: "utf-8",
      932: "shift_jis",
      936: "gbk",
      949: "euc-kr",
      950: "big5",
      874: "windows-874",
      10000: "macintosh",
      54936: "gb18030",
    } as Record<number, string>
  )[codePage] ?? `windows-${codePage}`;

export function openRtf(bytes: ArrayBuffer): OfficeWorkerResult {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new PreviewError({ code: "rtf-too-large" });
  // Keep byte offsets intact for binary destinations and multibyte code pages.
  const input = new Uint8Array(bytes);
  let source = "";
  for (let offset = 0; offset < input.length; offset += 8192)
    source += String.fromCharCode(...input.subarray(offset, offset + 8192));
  if (!source.startsWith("{\\rtf")) throw new PreviewError({ code: "rtf-invalid" });
  let state = {
    skip: false,
    deleted: false,
    hiddenText: false,
    bold: false,
    italic: false,
    underline: false,
    uc: 1,
    font: 0,
    fontTable: false,
    fontFile: false,
    decoder: new TextDecoder("windows-1252"),
  };
  // A font's \cpg, else its \fcharset, encodes the bytes written in that font. A \cpg inside
  // \fontfile encodes the font's file name instead.
  const fonts = new Map<number, TextDecoder>();
  let defaultFont = 0;
  const stack: (typeof state)[] = [];
  let html = "";
  const pages: { title: undefined; html: string }[] = [];
  let completedLength = 0;
  const finishPage = () => {
    if (pages.length >= 500) throw new PreviewError({ code: "rtf-too-many-pages" });
    pages.push({ title: undefined, html: `<p data-rtf-whitespace>${html}</p>` });
    completedLength += html.length;
    html = "";
  };
  let run = "";
  let fallback = 0;
  const hidden = () => state.skip || state.deleted || state.hiddenText;
  const encoded = new Uint8Array(bytes.byteLength);
  let encodedLength = 0;
  const decodeBytes = () => {
    if (!encodedLength) return;
    run += escape(
      (fonts.get(state.font) ?? state.decoder).decode(encoded.subarray(0, encodedLength)),
    );
    encodedLength = 0;
  };
  const flush = () => {
    decodeBytes();
    if (completedLength + html.length + run.length > 8 * 1024 * 1024)
      throw new PreviewError({ code: "rtf-too-much-content" });
    if (!run) return;
    let span = run;
    if (state.bold) span = `<strong>${span}</strong>`;
    if (state.italic) span = `<em>${span}</em>`;
    if (state.underline) span = `<u>${span}</u>`;
    html += span;
    run = "";
  };
  const emit = (value: string, skip = hidden()) => {
    if (fallback > 0) {
      fallback--;
      return;
    }
    if (skip) return;
    decodeBytes();
    run += escape(value);
    if (completedLength + html.length + run.length > 8 * 1024 * 1024)
      throw new PreviewError({ code: "rtf-too-much-content" });
  };
  const emitByte = (value: number) => {
    if (fallback > 0) fallback--;
    else if (!hidden()) encoded[encodedLength++] = value;
  };
  for (let i = 0; i < source.length;) {
    const char = source[i++];
    if (char === "{") {
      flush();
      fallback = 0;
      if (stack.length > 100) throw new PreviewError({ code: "rtf-too-deep" });
      stack.push({ ...state });
    } else if (char === "}") {
      flush();
      fallback = 0;
      const parent = stack.pop();
      if (!parent) throw new PreviewError({ code: "rtf-damaged" });
      state = parent;
    } else if (char === "\\") {
      const next = source[i];
      if (next === "'") {
        const hex = source.slice(i + 1, i + 3);
        if (!/^[\da-f]{2}$/i.test(hex)) throw new PreviewError({ code: "rtf-byte-escape" });
        i += 3;
        emitByte(Number.parseInt(hex, 16));
        continue;
      }
      // \u, \uc and skipped fallbacks change no formatting, so a character written as two \u
      // words stays in one run.
      if (fallback === 0 && !/^uc?-?\d/.test(source.slice(i, i + 4))) flush();
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
        const character = RTF_CHARACTERS.get(next!);
        if (character) emit(character);
        // A backslash before a line break is \par; TextEdit ends paragraphs this way.
        else if (next === "\n" || next === "\r") {
          if (fallback > 0) fallback--;
          else if (!hidden()) html += "<br>";
        }
        i++;
        continue;
      }
      i += match[0].length;
      const word = match[1];
      const arg = match[2] === undefined ? 1 : Number(match[2]);
      if (word === "bin") {
        if (!Number.isSafeInteger(arg) || arg < 0 || arg > source.length - i)
          throw new PreviewError({ code: "rtf-binary-data" });
        i += arg;
      }
      if (fallback > 0) {
        fallback--;
        continue;
      }
      if (word === "fonttbl") {
        state.fontTable = true;
        state.skip = true;
      } else if (word === "deff") state.font = defaultFont = arg;
      else if (word === "f") state.font = arg;
      else if (word === "fcharset" && state.fontTable) {
        const label = (
          {
            0: "windows-1252",
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
      } else if (word === "fontfile") state.fontFile = true;
      else if (word === "cpg" && state.fontTable && !state.fontFile) {
        try {
          fonts.set(state.font, new TextDecoder(rtfCodePageLabel(arg)));
        } catch {
          // An unknown font code page leaves the font on its \fcharset.
        }
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
      else if (word === "mac") state.decoder = new TextDecoder("macintosh");
      else if (word === "ansicpg") {
        try {
          state.decoder = new TextDecoder(rtfCodePageLabel(arg));
        } catch {
          throw new PreviewError({ code: "rtf-code-page" });
        }
      } else if (word === "b") state.bold = arg !== 0;
      else if (word === "i") state.italic = arg !== 0;
      else if (RTF_UNDERLINE_WORD.test(word!)) state.underline = arg !== 0;
      else if (word === "ulnone") state.underline = false;
      else if (word === "deleted") state.deleted = arg !== 0;
      else if (word === "v") state.hiddenText = arg !== 0;
      else if (word === "plain")
        state = {
          ...state,
          deleted: false,
          hiddenText: false,
          bold: false,
          italic: false,
          underline: false,
          font: defaultFont,
        };
      else if (word === "uc") state.uc = Math.max(0, Math.min(10, arg));
      else if (word === "u") {
        fallback = 0;
        // TextEdit writes a soft line break as U+2028, where Chromium does not break the line.
        if (arg !== 0x2028) emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
        else if (!hidden()) {
          flush();
          html += "<br>";
        }
        fallback = state.uc;
      } else if (!hidden() && word === "page") finishPage();
      else if (word === "cell" || word === "nestcell") emit("\t", state.skip);
      else if (
        (!state.skip && word === "row") ||
        (!hidden() && (word === "par" || word === "line"))
      )
        html += "<br>";
      // Writers usually end the paragraph before these breaks; a second break would add a blank line.
      else if (!hidden() && (word === "sect" || word === "column")) {
        if (html && !html.endsWith("<br>")) html += "<br>";
      } else {
        const character = RTF_CHARACTERS.get(word!);
        if (character) emit(character);
      }
    } else if (char !== "\r" && char !== "\n" && char) emitByte(char.charCodeAt(0));
  }
  if (stack.length) throw new PreviewError({ code: "rtf-damaged" });
  flush();
  if (html || !pages.length) finishPage();
  return { type: "document", navigation: "page", pages };
}
