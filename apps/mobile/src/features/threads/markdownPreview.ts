/**
 * The markdown as plain lines: one per paragraph, list item or code line, with the syntax dropped.
 * The native markdown view cannot cut its text at a line, so a clamped preview is plain text.
 */
export function markdownPreviewText(markdown: string): string {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (line.trim() === "") continue;
    if (inFence) {
      lines.push(line);
      continue;
    }
    lines.push(
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "• ")
        .replace(/^\s*>\s?/, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/(?<![\w*])\*(?=\S)(.+?)\*(?![\w*])/g, "$1")
        .replace(/`([^`]*)`/g, "$1"),
    );
  }
  return lines.join("\n");
}
