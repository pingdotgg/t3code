import remarkParse from "remark-parse";
import { unified } from "unified";

const planParser = unified().use(remarkParse).freeze();

function headingText(line: string): string | null {
  const heading = line.match(/^ {0,3}#{1,6}([ \t].*)?$/);
  if (!heading) return null;
  const text = heading[1] ?? "";
  return text.replace(/[ \t]#+[ \t]*$/, "").trim();
}

function findPlanTitle(lines: readonly string[]) {
  for (const node of planParser.parse(lines.join("\n")).children) {
    if (node.type !== "heading" || !node.position) continue;
    const index = node.position.start.line - 1;
    const heading = headingText(lines[index] ?? "");
    if (heading) return { index, text: heading };
  }
  return null;
}

export function proposedPlanTitle(planMarkdown: string): string | null {
  return findPlanTitle(planMarkdown.replace(/^\uFEFF/, "").split(/\r\n?|\n/))?.text ?? null;
}

export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split(/\r\n?|\n/);
  const title = findPlanTitle(lines);
  let start = 0;
  let commentStart = -1;
  const preambleBlocks: Array<{ start: number; end: number }> = [];
  for (const line of lines) {
    if (commentStart < 0 && /^ {0,3}<!--/.test(line)) commentStart = start;
    if (commentStart < 0 && line.trim().length > 0 && headingText(line) !== "") break;
    const end = commentStart >= 0 ? line.indexOf("-->") : -1;
    if (end >= 0) {
      if (preambleBlocks.length > 0 || line.slice(end + 3).trim()) {
        preambleBlocks.push({ start: commentStart, end: start + 1 });
      }
      commentStart = -1;
    }
    start += 1;
  }
  const firstPreambleBlock = preambleBlocks[0];
  if (!title && firstPreambleBlock) {
    return lines.slice(firstPreambleBlock.start).join("\n");
  }
  const contentStart = start;
  if (title) start = title.index + 1;
  while (lines[start]?.trim().length === 0) {
    start += 1;
  }
  if (headingText(lines[start] ?? "")?.toLowerCase() === "summary") {
    start += 1;
    while (lines[start]?.trim().length === 0) {
      start += 1;
    }
  }
  const body = lines.slice(start).join("\n");
  if (title && title.index > contentStart) {
    const before = lines
      .slice(firstPreambleBlock?.start ?? contentStart, title.index)
      .join("\n")
      .trimEnd();
    // A blank line alone would merge some adjacent blocks, including ordered lists.
    return body ? `${before}\n\n<!-- -->\n\n${body}` : before;
  }
  if (!firstPreambleBlock) return body;
  const preamble = preambleBlocks
    .map(({ start, end }) => lines.slice(start, end).join("\n"))
    .join("\n");
  return body ? `${preamble}\n\n${body}` : preamble;
}
