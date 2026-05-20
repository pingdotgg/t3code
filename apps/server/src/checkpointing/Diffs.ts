import { parsePatchFiles } from "@pierre/diffs";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

function parseNumstatCount(value: string | undefined): number {
  if (value === undefined || value === "-") {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseTurnDiffFilesFromUnifiedDiff(
  diff: string,
): ReadonlyArray<TurnDiffFileSummary> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const parsedPatches = parsePatchFiles(normalized);
  const files = parsedPatches.flatMap((patch) =>
    patch.files.map((file) => ({
      path: file.name,
      additions: file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
      deletions: file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
    })),
  );

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  if (numstat.length === 0) {
    return [];
  }

  const records = numstat.split("\0");
  const files: TurnDiffFileSummary[] = [];
  let index = 0;
  while (index < records.length) {
    const header = records[index] ?? "";
    index += 1;
    if (header.length === 0) {
      continue;
    }

    const [additionsRaw, deletionsRaw, ...pathParts] = header.split("\t");
    if (additionsRaw === undefined || deletionsRaw === undefined) {
      continue;
    }

    let filePath = pathParts.join("\t");
    if (filePath.length === 0) {
      const oldPath = records[index] ?? "";
      const newPath = records[index + 1] ?? "";
      index += 2;
      filePath = newPath.length > 0 ? newPath : oldPath;
    }
    if (filePath.length === 0) {
      continue;
    }

    files.push({
      path: filePath,
      additions: parseNumstatCount(additionsRaw),
      deletions: parseNumstatCount(deletionsRaw),
    });
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}
