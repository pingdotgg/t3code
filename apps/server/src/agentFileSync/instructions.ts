import type { AgentFileSyncSection } from "@t3tools/contracts";

/** H2 sections retain their subheadings. H1-only files use H1 sections instead. */
export function instructionSections(text: string): AgentFileSyncSection[] {
  const lines = text
    .replace(/<!-- t3-sync:([a-f0-9]{64}) -->[\s\S]*?<!-- \/t3-sync:\1 -->\r?\n?/g, "")
    .split(/(?<=\n)/);
  const headings: { line: number; level: number; title: string }[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const [line, value] of lines.entries()) {
    const code = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(value);
    if (code) {
      const marker = code[1]!;
      if (!fence) fence = { char: marker[0]!, length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length && !code[2]!.trim())
        fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}(#{1,2})[ \t]+(.+?)\s*#*\s*$/.exec(value);
    if (heading) headings.push({ line, level: heading[1]!.length, title: heading[2]! });
  }
  const level = headings.some((heading) => heading.level === 2) ? 2 : 1;
  const starts = headings.filter((heading) => heading.level === level);
  if (starts[0]?.line !== 0) starts.unshift({ line: 0, level: 0, title: "Introduction" });
  const counts = new Map<string, number>();
  return starts.flatMap((start, index) => {
    const contents = lines.slice(start.line, starts[index + 1]?.line).join("");
    if (!contents.trim()) return [];
    const occurrence = counts.get(start.title) ?? 0;
    counts.set(start.title, occurrence + 1);
    return [{ id: `${start.title}:${occurrence}`, title: start.title, contents }];
  });
}

/** A managed block is the only text a later sync may replace. */
export function mergeInstructionSection(text: string, id: string, contents: string): string | null {
  const begin = `<!-- t3-sync:${id} -->`;
  const end = `<!-- /t3-sync:${id} -->`;
  const start = text.indexOf(begin);
  const finish = text.indexOf(end);
  if (
    start < 0 !== finish < 0 ||
    (start >= 0 &&
      (finish < start ||
        text.indexOf(begin, start + begin.length) >= 0 ||
        text.indexOf(end, finish + end.length) >= 0))
  )
    return null;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = `${begin}${eol}${contents.trimEnd().replace(/\r?\n/g, eol)}${eol}${end}`;
  if (start >= 0) return text.slice(0, start) + block + text.slice(finish + end.length);
  return text + (text.length ? (text.endsWith(eol) ? eol : eol + eol) : "") + block + eol;
}
