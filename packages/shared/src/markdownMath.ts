/// <reference types="mdast-util-to-hast" />
import type { Root, RootContent } from "mdast";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import type { Parser, Plugin } from "unified";

const proseParser = unified().use(remarkParse).use(remarkGfm).freeze();
const MAX_MATH_LENGTH = 4096;

function escaped(source: string, offset: number) {
  let slashes = 0;
  while (offset > 0 && source[--offset] === "\\") slashes++;
  return slashes % 2 === 1;
}

/** Translate chat delimiters to remark-math's dollar syntax. Replacements keep
 * their UTF-16 lengths so task markers, citations and editor ranges keep offsets. */
function normalizeMath(source: string) {
  let marker = 0xe000;
  const used = new Set(source.match(/[\uE000-\uF8FF]/g) ?? []);
  const ignored: Array<{ start: number; end: number }> = [];
  const tables: Array<{ start: number; end: number }> = [];
  const visit = (node: Root | RootContent) => {
    for (const value of ["value" in node ? node.value : "", "url" in node ? node.url : ""])
      for (const symbol of value.match(/[\uE000-\uF8FF]/g) ?? []) used.add(symbol);
    if (node.type === "table") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) tables.push({ start, end });
    }
    if (
      [
        "code",
        "inlineCode",
        "html",
        "link",
        "image",
        "definition",
        "linkReference",
        "imageReference",
      ].includes(node.type)
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ignored.push({ start, end });
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(proseParser.parse(source));
  const unusedMarker = () => {
    while (marker <= 0xf8ff && used.has(String.fromCharCode(marker))) marker++;
    return marker <= 0xf8ff ? String.fromCharCode(marker++) : null;
  };
  const padding = unusedMarker();
  const dollar = unusedMarker();
  const pipe = unusedMarker();
  const newline = unusedMarker();
  const carriage = unusedMarker();
  if (padding === null || dollar === null || pipe === null || newline === null || carriage === null)
    return null;
  const chars = source.split("");
  const overlaps = (start: number, end: number) =>
    ignored.some((range) => start < range.end && end > range.start);
  const ranges = new Map<number, { end: number; display: boolean }>();
  const openings = /\\[([]|\${1,2}/g;
  for (let match; (match = openings.exec(source));) {
    const start = match.index;
    const open = match[0];
    if (escaped(source, start)) {
      openings.lastIndex = start + 1;
      continue;
    }
    if (overlaps(start, start + open.length)) continue;
    if (
      open[0] === "$" &&
      ((source[start - 1] === "$" && !escaped(source, start - 1)) ||
        source[start + open.length] === "$")
    )
      continue;
    const close = open === "\\(" ? "\\)" : open === "\\[" ? "\\]" : open;
    const limit = start + MAX_MATH_LENGTH + open.length + close.length;
    const bounded = source.slice(start, limit);
    let end = bounded.indexOf(close, open.length);
    if (end !== -1) end += start;
    while (
      end !== -1 &&
      end - start <= MAX_MATH_LENGTH &&
      (escaped(source, end) || (open[0] === "$" && source[end + close.length] === "$"))
    ) {
      const next = bounded.indexOf(close, end - start + close.length);
      end = next === -1 ? -1 : next + start;
    }
    if (end === -1 || end - start > MAX_MATH_LENGTH) continue;
    const body = source.slice(start + open.length, end);
    if (!body) continue;
    if (open === "$" && (/^\s|\s$|[\r\n]/.test(body) || /\d/.test(source[end + 1] ?? ""))) continue;
    if (open === "\\[" && /^[\d,\s]+$/.test(body)) continue;
    // GFM cells cannot continue into the next row.
    if (/[\r\n]/.test(body) && tables.some((table) => start >= table.start && start < table.end))
      continue;
    const display = open === "$$" || open === "\\[";
    const block =
      display &&
      /^[ \t]*\r?\n/.test(body) &&
      /^[ \t>]*$/.test(source.slice(source.lastIndexOf("\n", end - 1) + 1, end));
    if (!block && (/`|:\/\//.test(body) || overlaps(start, end + close.length))) continue;
    const normalizedOpen = block ? "$$" : "$" + padding.repeat(open.length - 1);
    const normalizedClose = block ? "$$" : padding.repeat(close.length - 1) + "$";
    for (let index = 0; index < open.length; index++) chars[start + index] = normalizedOpen[index]!;
    for (let index = 0; index < close.length; index++) chars[end + index] = normalizedClose[index]!;
    for (let index = start + open.length; index < end; index++) {
      if (source[index] === "|") chars[index] = pipe;
      else if (source[index] === "$") chars[index] = dollar;
      else if (!block && source[index] === "\n") chars[index] = newline;
      else if (!block && source[index] === "\r") chars[index] = carriage;
    }
    ranges.set(start, { end: end + close.length, display });
    openings.lastIndex = end + close.length;
  }
  // Unmatched, escaped and currency dollars must remain prose with single-dollar math enabled.
  for (let index = 0; index < chars.length; index++) {
    const range = ranges.get(index);
    if (range) {
      index = range.end - 1;
      continue;
    }
    if (source[index] === "$" && !escaped(source, index) && !overlaps(index, index + 1))
      chars[index] = dollar;
  }
  const decode = (value: string) =>
    value
      .replaceAll(padding, "")
      .replaceAll(dollar, "$")
      .replaceAll(pipe, "|")
      .replaceAll(newline, "\n")
      .replaceAll(carriage, "\r");
  const lines = [0];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) lines.push(match.index + match[0].length);
  const restore = (node: Root | RootContent, inTable = false) => {
    const table = inTable || node.type === "tableCell";
    if ("value" in node) node.value = decode(node.value);
    if ("url" in node) node.url = decode(node.url);
    if (node.position)
      for (const point of [node.position.start, node.position.end]) {
        if (point.offset === undefined) continue;
        let low = 0;
        let high = lines.length;
        while (low + 1 < high) {
          const middle = (low + high) >>> 1;
          if (lines[middle]! <= point.offset) low = middle;
          else high = middle;
        }
        point.line = low + 1;
        point.column = point.offset - lines[low]! + 1;
      }
    if (node.type === "math" || node.type === "inlineMath") {
      if (table)
        node.value = node.value.replace(/(\\+)\|/g, (match, slashes: string) =>
          slashes.length % 2 === 1 ? `${slashes.slice(1)}|` : match,
        );
      const display =
        ranges.get(node.position?.start.offset ?? -1)?.display ?? node.type === "math";
      node.data = {
        hName: "code",
        hProperties: { className: ["language-math", display ? "math-display" : "math-inline"] },
        hChildren: [{ type: "text", value: node.value }],
      };
    } else if ("children" in node) node.children.forEach((child) => restore(child, table));
  };
  return { value: chars.join(""), restore };
}

/** remark-math owns tokenization; this adapter preserves chat syntax and authored offsets. */
export const remarkChatMath: Plugin<[], Root> = function () {
  remarkMath.call(this, { singleDollarTextMath: true });
  const parse = this.parser as Parser<Root> | undefined;
  if (parse)
    this.parser = (source, file) => {
      const normalized = normalizeMath(source);
      if (!normalized) return proseParser.parse(source);
      const tree = parse(normalized.value, file);
      normalized.restore(tree);
      return tree;
    };
};

const mathParser = unified().use(remarkParse).use(remarkGfm).use(remarkChatMath).freeze();

export function parseMarkdownWithMath(source: string) {
  return mathParser.parse(source);
}

/** Closed, parser-owned formulas with authored source for editors and native rendering. */
export function markdownMathRanges(source: string, tree?: Root) {
  const ranges: Array<{
    start: number;
    end: number;
    source: string;
    tex: string;
    display: boolean;
    inTable: boolean;
  }> = [];
  if (!mayContainMath(source)) return ranges;
  const visit = (node: Root | Root["children"][number], inTable = false) => {
    const table = inTable || node.type === "tableCell";
    if (
      node.type === "math" ||
      node.type === "inlineMath" ||
      (node.type === "code" && node.lang === "math")
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const authored = source.slice(start, end);
      if (node.type === "code") {
        const open = /^[ \t]*(`{3,}|~{3,})/.exec(authored)?.[1];
        const close = /\n[ \t>]*(`{3,}|~{3,})[ \t\r]*$/.exec(authored)?.[1];
        if (!open || !close || open[0] !== close[0] || close.length < open.length) return;
      }
      const display = node.type !== "inlineMath" || /^(?:\$\$|\\\[)/.test(authored);
      ranges.push({ start, end, source: authored, tex: node.value, display, inTable: table });
    } else if ("children" in node) node.children.forEach((child) => visit(child, table));
  };
  visit(tree ?? parseMarkdownWithMath(source));
  return ranges;
}

/** Messages without these characters skip math parsing entirely. */
export function mayContainMath(text: string): boolean {
  return (
    text.includes("$") ||
    text.includes("\\(") ||
    text.includes("\\[") ||
    /(?:`{3,}|~{3,})[ \t]*math\b/.test(text)
  );
}

export function mathKind(className: string | undefined): "inline" | "display" | null {
  if (!className?.includes("language-math")) return null;
  if (className.includes("math-display")) return "display";
  return className.includes("math-inline") ? "inline" : null;
}
