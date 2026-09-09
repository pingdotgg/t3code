export interface LogicalChangeUnit {
  readonly id: string;
  readonly fileKey: number;
  readonly filePath: string;
  readonly kind: "hunk" | "whole-file";
  readonly header: string;
  readonly body: string;
}

const UNSPLITTABLE_HEADER_PATTERN =
  /^(?:new file mode|deleted file mode|rename from|rename to|copy from|copy to|old mode|new mode|GIT binary patch|Binary files)/m;

function splitLinesPreservingEndings(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function displayPath(header: string): string {
  const destination = header.match(/^\+\+\+ (.+)$/m)?.[1]?.trim();
  if (destination && destination !== "/dev/null") {
    return destination.replace(/^"?b\//, "").replace(/"$/, "");
  }
  const source = header.match(/^--- (.+)$/m)?.[1]?.trim();
  if (source && source !== "/dev/null") {
    return source.replace(/^"?a\//, "").replace(/"$/, "");
  }
  return "(unknown file)";
}

function withoutIndexLine(header: string): string {
  return splitLinesPreservingEndings(header)
    .filter((line) => !line.startsWith("index "))
    .join("");
}

export function parseLogicalChangeUnits(stagedPatch: string): LogicalChangeUnit[] {
  const sections = stagedPatch
    .split(/(?=^diff --git )/m)
    .filter((section) => section.startsWith("diff --git "));
  const units: LogicalChangeUnit[] = [];

  for (const [fileKey, section] of sections.entries()) {
    const lines = splitLinesPreservingEndings(section);
    const firstHunkIndex = lines.findIndex((line) => line.startsWith("@@ "));
    const rawHeader = firstHunkIndex === -1 ? section : lines.slice(0, firstHunkIndex).join("");
    const filePath = displayPath(rawHeader);
    const isWholeFile = firstHunkIndex === -1 || UNSPLITTABLE_HEADER_PATTERN.test(rawHeader);

    if (isWholeFile) {
      units.push({
        id: "",
        fileKey,
        filePath,
        kind: "whole-file",
        header: "",
        body: section.endsWith("\n") ? section : `${section}\n`,
      });
      continue;
    }

    const header = withoutIndexLine(rawHeader);
    let hunkStart = firstHunkIndex;
    while (hunkStart < lines.length) {
      let nextHunk = hunkStart + 1;
      while (nextHunk < lines.length && !lines[nextHunk]?.startsWith("@@ ")) {
        nextHunk += 1;
      }
      units.push({
        id: "",
        fileKey,
        filePath,
        kind: "hunk",
        header,
        body: lines.slice(hunkStart, nextHunk).join(""),
      });
      hunkStart = nextHunk;
    }
  }

  const width = Math.max(3, String(units.length).length);
  return units.map((unit, index) => ({
    ...unit,
    id: `H${String(index + 1).padStart(width, "0")}`,
  }));
}

export function summarizeLogicalChangeUnits(units: ReadonlyArray<LogicalChangeUnit>): string {
  return units
    .map((unit) => {
      const hunkHeader = unit.kind === "hunk" ? unit.body.split("\n", 1)[0] : "whole-file change";
      return `${unit.id}\t${unit.filePath}\t${hunkHeader}`;
    })
    .join("\n");
}

export function formatLogicalChangeUnitsForModel(units: ReadonlyArray<LogicalChangeUnit>): string {
  return units
    .map(
      (unit) =>
        `### ${unit.id} — ${unit.filePath}${unit.kind === "whole-file" ? " (whole file)" : ""}\n${unit.body}`,
    )
    .join("\n");
}

export function buildPatchForLogicalChangeUnits(units: ReadonlyArray<LogicalChangeUnit>): string {
  const byFile = new Map<number, LogicalChangeUnit[]>();
  for (const unit of units) {
    const fileUnits = byFile.get(unit.fileKey) ?? [];
    fileUnits.push(unit);
    byFile.set(unit.fileKey, fileUnits);
  }

  return [...byFile.values()]
    .map((fileUnits) => {
      const first = fileUnits[0];
      if (!first) return "";
      if (first.kind === "whole-file") return first.body;
      return `${first.header}${fileUnits.map((unit) => unit.body).join("")}`;
    })
    .join("");
}
