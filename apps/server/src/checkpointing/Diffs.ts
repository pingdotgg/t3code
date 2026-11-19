export interface TurnDiffFileSummary {
  readonly path: string;
  readonly previousPath?: string;
  readonly additions: number;
  readonly deletions: number;
}

export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  const records = numstat.split("\0");
  const files: TurnDiffFileSummary[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!counts) continue;

    let path = record.slice(counts[0].length);
    let previousPath: string | undefined;
    if (path.length === 0) {
      previousPath = records[index + 1];
      path = records[index + 2] ?? "";
      index += 2;
    }
    if (path.length === 0) continue;

    files.push({
      path,
      ...(previousPath === undefined ? {} : { previousPath }),
      additions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2]),
    });
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

// A file inside a nested repository counts as authored when its gitlink was.
function isAuthored(filePath: string, authoredPaths: ReadonlySet<string>): boolean {
  for (let end = filePath.length; end > 0; end = filePath.lastIndexOf("/", end - 1)) {
    if (authoredPaths.has(filePath.slice(0, end))) return true;
  }
  return false;
}

export function isGitImport(
  file: TurnDiffFileSummary,
  authoredPaths: ReadonlySet<string> | null,
): boolean {
  return (
    authoredPaths !== null &&
    !isAuthored(file.path, authoredPaths) &&
    (file.previousPath === undefined || !isAuthored(file.previousPath, authoredPaths))
  );
}
