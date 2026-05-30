export type ParsedDiffLineType = "context" | "add" | "delete" | "meta" | "hunk";

export interface ParsedDiffLine {
  readonly id: string;
  readonly type: ParsedDiffLineType;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly content: string;
}

export interface ParsedDiffFile {
  readonly id: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly lines: ReadonlyArray<ParsedDiffLine>;
}

function parseHunkStart(
  line: string,
): { readonly oldLine: number; readonly newLine: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) {
    return null;
  }

  return {
    oldLine: Number.parseInt(match[1] ?? "0", 10),
    newLine: Number.parseInt(match[2] ?? "0", 10),
  };
}

function parseDiffPath(line: string, prefix: "--- " | "+++ "): string | null {
  if (!line.startsWith(prefix)) {
    return null;
  }
  const raw = line.slice(prefix.length).trim();
  if (raw === "/dev/null") {
    return null;
  }
  return raw.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(diff: string): ReadonlyArray<ParsedDiffFile> {
  const files: ParsedDiffFile[] = [];
  let current: {
    oldPath: string | null;
    newPath: string | null;
    lines: ParsedDiffLine[];
  } | null = null;
  let oldLine: number | null = null;
  let newLine: number | null = null;

  const pushCurrent = () => {
    if (!current) {
      return;
    }
    files.push({
      id: `${current.oldPath ?? "null"}:${current.newPath ?? "null"}:${files.length}`,
      oldPath: current.oldPath,
      newPath: current.newPath,
      lines: current.lines,
    });
  };

  for (const rawLine of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      pushCurrent();
      const match = rawLine.match(/^diff --git a\/(.+) b\/(.+)$/);
      current = {
        oldPath: match?.[1] ?? null,
        newPath: match?.[2] ?? null,
        lines: [],
      };
      oldLine = null;
      newLine = null;
      continue;
    }

    if (!current) {
      if (rawLine.trim().length === 0) {
        continue;
      }
      current = { oldPath: null, newPath: null, lines: [] };
    }

    const oldPath = parseDiffPath(rawLine, "--- ");
    if (oldPath !== null || rawLine === "--- /dev/null") {
      current.oldPath = oldPath;
      continue;
    }

    const newPath = parseDiffPath(rawLine, "+++ ");
    if (newPath !== null || rawLine === "+++ /dev/null") {
      current.newPath = newPath;
      continue;
    }

    const hunk = parseHunkStart(rawLine);
    if (hunk) {
      oldLine = hunk.oldLine;
      newLine = hunk.newLine;
      current.lines.push({
        id: `${current.lines.length}:hunk`,
        type: "hunk",
        oldLine: null,
        newLine: null,
        content: rawLine,
      });
      continue;
    }

    if (oldLine === null || newLine === null) {
      current.lines.push({
        id: `${current.lines.length}:meta`,
        type: "meta",
        oldLine: null,
        newLine: null,
        content: rawLine,
      });
      continue;
    }

    const marker = rawLine[0];
    const content = rawLine.length > 0 ? rawLine.slice(1) : "";
    if (marker === "+") {
      current.lines.push({
        id: `${current.lines.length}:add:${newLine}`,
        type: "add",
        oldLine: null,
        newLine,
        content,
      });
      newLine += 1;
    } else if (marker === "-") {
      current.lines.push({
        id: `${current.lines.length}:delete:${oldLine}`,
        type: "delete",
        oldLine,
        newLine: null,
        content,
      });
      oldLine += 1;
    } else {
      current.lines.push({
        id: `${current.lines.length}:context:${oldLine}:${newLine}`,
        type: "context",
        oldLine,
        newLine,
        content: marker === " " ? content : rawLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  pushCurrent();
  return files.filter((file) => file.lines.length > 0 || file.oldPath || file.newPath);
}
