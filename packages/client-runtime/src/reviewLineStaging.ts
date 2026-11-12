import type { SelectedLineRange } from "@pierre/diffs";

interface PatchRow {
  prefix: " " | "+" | "-";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  noNewline: boolean;
}

/** Keep unselected changes on the source side, so Git applies just the selected lines. */
export function reviewSelectedLinesPatch(
  patches: ReadonlyArray<string>,
  range: SelectedLineRange,
  staged: boolean,
  diffStyle: "unified" | "split" = "unified",
): string | undefined {
  const hunks: { oldStart: number; newStart: number; rows: PatchRow[] }[] = [];
  let header = "";
  for (const patch of patches) {
    const parts = patch.split(/(?=^@@ )/m);
    header ||= (parts.shift() ?? "").replace(/^index .*\n/gm, "");
    for (const part of parts) {
      const lines = part.split("\n");
      const match = lines.shift()?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) continue;
      const oldStart = Number(match[1]) + (match[2] === "0" ? 1 : 0);
      const newStart = Number(match[3]) + (match[4] === "0" ? 1 : 0);
      let oldLine = oldStart;
      let newLine = newStart;
      const rows: PatchRow[] = [];
      for (const line of lines) {
        if (line.startsWith("\\ No newline")) {
          const previous = rows.at(-1);
          if (previous) previous.noNewline = true;
          continue;
        }
        const prefix = line[0];
        if (prefix !== " " && prefix !== "+" && prefix !== "-") continue;
        rows.push({
          prefix,
          text: line.slice(1),
          oldLine: prefix === "+" ? null : oldLine++,
          newLine: prefix === "-" ? null : newLine++,
          noNewline: false,
        });
      }
      hunks.push({ oldStart, newStart, rows });
    }
  }
  const rows = hunks.flatMap((hunk) => hunk.rows);
  const side = range.side ?? "additions";
  const endSide = range.endSide ?? side;
  const lineAt = (row: PatchRow, atSide: "additions" | "deletions") =>
    atSide === "deletions" ? row.oldLine : row.newLine;
  const first = rows.findIndex((row) => lineAt(row, side) === range.start);
  const last = rows.findIndex((row) => lineAt(row, endSide) === range.end);
  const low = Math.min(range.start, range.end);
  const high = Math.max(range.start, range.end);
  const positions = new Map<PatchRow, number>();
  let position = 0;
  for (const hunk of hunks) {
    for (let index = 0; index < hunk.rows.length;) {
      const row = hunk.rows[index]!;
      if (diffStyle === "unified" || row.prefix === " ") {
        positions.set(row, position++);
        index += 1;
        continue;
      }
      let deletions = 0;
      let additions = 0;
      while (index < hunk.rows.length && hunk.rows[index]?.prefix !== " ") {
        const changed = hunk.rows[index++]!;
        positions.set(changed, position + (changed.prefix === "-" ? deletions++ : additions++));
      }
      position += Math.max(deletions, additions);
    }
  }
  const matchingSide = rows.filter((row) => {
    const line = lineAt(row, side);
    return line !== null && line >= low && line <= high;
  });
  const startRow = first >= 0 ? rows[first] : side === endSide ? matchingSide[0] : undefined;
  const endRow = last >= 0 ? rows[last] : side === endSide ? matchingSide.at(-1) : undefined;
  const startPosition = startRow ? positions.get(startRow) : undefined;
  const endPosition = endRow ? positions.get(endRow) : undefined;
  const selected = new Set(
    rows.filter((row) => {
      const at = positions.get(row);
      return (
        row.prefix !== " " &&
        at !== undefined &&
        startPosition !== undefined &&
        endPosition !== undefined &&
        at >= Math.min(startPosition, endPosition) &&
        at <= Math.max(startPosition, endPosition)
      );
    }),
  );
  if (selected.size === 0) return undefined;

  let delta = 0;
  const output: string[] = [];
  for (const hunk of hunks) {
    const ordered =
      diffStyle === "split"
        ? [...hunk.rows].sort((a, b) => positions.get(a)! - positions.get(b)!)
        : hunk.rows;
    const transformed = ordered.flatMap((row) => {
      if (row.prefix === " " || selected.has(row)) return [{ ...row }];
      if (row.prefix === (staged ? "-" : "+")) return [];
      return [{ ...row, prefix: " " as const }];
    });
    const oldCount = transformed.filter((row) => row.prefix !== "+").length;
    const newCount = transformed.filter((row) => row.prefix !== "-").length;
    if (hunk.rows.some((row) => selected.has(row))) {
      // Forward patches start in the index; reverse patches end in the index.
      // The other side's positions account only for the changes being applied.
      const oldStart = staged ? hunk.newStart - delta : hunk.oldStart;
      const newStart = staged ? hunk.newStart : hunk.oldStart + delta;
      output.push(
        `@@ -${oldCount === 0 ? Math.max(0, oldStart - 1) : Math.max(1, oldStart)},${oldCount} +${newCount === 0 ? Math.max(0, newStart - 1) : Math.max(1, newStart)},${newCount} @@\n` +
          transformed
            .map(
              (row) =>
                `${row.prefix}${row.text}\n${row.noNewline ? "\\ No newline at end of file\n" : ""}`,
            )
            .join(""),
      );
    }
    delta += newCount - oldCount;
  }
  // A partial deletion still leaves a file; a partial reverse addition does too.
  const partialDeletion = !staged && rows.some((row) => row.prefix === "-" && !selected.has(row));
  const partialAddition = staged && rows.some((row) => row.prefix === "+" && !selected.has(row));
  if (partialDeletion && header.includes("deleted file mode")) {
    header = header.replace(/^deleted file mode .*\n/gm, "");
    const oldPath = header.match(/^--- (.*)$/m)?.[1];
    if (oldPath)
      header = header.replace(
        /^\+\+\+ \/dev\/null$/m,
        `+++ ${oldPath.replace(/^("?)a\//, "$1b/")}`,
      );
  }
  if (partialAddition && header.includes("new file mode")) {
    header = header.replace(/^new file mode .*\n/gm, "");
    const newPath = header.match(/^\+\+\+ (.*)$/m)?.[1];
    if (newPath)
      header = header.replace(/^--- \/dev\/null$/m, `--- ${newPath.replace(/^("?)b\//, "$1a/")}`);
  }
  return header + output.join("");
}
