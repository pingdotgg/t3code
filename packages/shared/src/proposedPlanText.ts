function headingText(line: string): string | null {
  const heading = line.match(/^ {0,3}#{1,6}([ \t].*)?$/);
  if (!heading) return null;
  const text = heading[1] ?? "";
  return text.replace(/[ \t]#+[ \t]*$/, "").trim();
}

function findPlanTitle(lines: readonly string[]) {
  let fence = "";
  let comment = false;
  for (const [index, line] of lines.entries()) {
    const [, marker = "", info = ""] = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/) ?? [];
    if (fence) {
      if (marker[0] === fence[0] && marker.length >= fence.length && /^[ \t]*$/.test(info)) {
        fence = "";
      }
      continue;
    }
    if (comment || /^ {0,3}<!--/.test(line)) {
      comment = !line.includes("-->");
      continue;
    }
    // CommonMark: a backtick fence's info string cannot contain a backtick.
    if (marker && (marker[0] !== "`" || !info.includes("`"))) {
      fence = marker;
      continue;
    }
    const heading = headingText(line);
    if (heading) return { index, text: heading };
  }
  return null;
}

export function proposedPlanTitle(planMarkdown: string): string | null {
  return findPlanTitle(planMarkdown.replace(/^\uFEFF/, "").split(/\r?\n/))?.text ?? null;
}

export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split(/\r?\n/);
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
  if (title?.index === start) {
    start += 1;
  } else if (title && title.index > start) {
    // Keep the blocks on either side of the title separate.
    lines[title.index] = "";
    return lines
      .slice(firstPreambleBlock?.start ?? start)
      .join("\n")
      .trimEnd();
  } else if (firstPreambleBlock) {
    return lines.slice(firstPreambleBlock.start).join("\n");
  }
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
  if (!firstPreambleBlock) return body;
  const preamble = preambleBlocks
    .map(({ start, end }) => lines.slice(start, end).join("\n"))
    .join("\n");
  return body ? `${preamble}\n\n${body}` : preamble;
}
