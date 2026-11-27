export function proposedPlanTitle(planMarkdown: string): string | null {
  let fence = "";
  for (const line of planMarkdown.split(/\r?\n/)) {
    const [, marker = "", info = ""] = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/) ?? [];
    if (fence) {
      if (marker[0] === fence[0] && marker.length >= fence.length && !info.trim()) fence = "";
      continue;
    }
    // CommonMark: a backtick fence's info string cannot contain a backtick.
    if (marker && (marker[0] !== "`" || !info.includes("`"))) {
      fence = marker;
      continue;
    }
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.+)$/)?.[1]?.trim();
    if (heading) return heading;
  }
  return null;
}

export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  let start = 0;
  while (lines[start]?.trim().length === 0 || /^ {0,3}#{1,6}[ \t]*$/.test(lines[start] ?? "")) {
    start += 1;
  }
  if (/^ {0,3}#{1,6}[ \t]+\S/.test(lines[start] ?? "")) start += 1;
  while (lines[start]?.trim().length === 0) {
    start += 1;
  }
  const firstHeadingMatch = lines[start]?.match(/^ {0,3}#{1,6}[ \t]+(.+)$/);
  if (firstHeadingMatch?.[1]?.trim().toLowerCase() === "summary") {
    start += 1;
    while (lines[start]?.trim().length === 0) {
      start += 1;
    }
  }
  return lines.slice(start).join("\n");
}
