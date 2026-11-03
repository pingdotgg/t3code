export interface TurnDiffFileSummary {
  readonly path: string;
  readonly previousPath?: string;
  readonly kind: "added" | "deleted" | "renamed" | "modified";
  readonly additions: number;
  readonly deletions: number;
  readonly binary?: true;
}

// Copies name a new file; type changes and other statuses count as edits.
const KIND_BY_RAW_STATUS: Readonly<Record<string, TurnDiffFileSummary["kind"]>> = {
  A: "added",
  C: "added",
  D: "deleted",
  R: "renamed",
};

/** Parses `git diff --raw --numstat -z`; without `--raw` records every file is "modified". */
export function parseTurnDiffFilesFromNumstat(numstat: string): ReadonlyArray<TurnDiffFileSummary> {
  const records = numstat.split("\0");
  const kinds = new Map<string, TurnDiffFileSummary["kind"]>();
  const files: Array<Omit<TurnDiffFileSummary, "kind">> = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith(":")) {
      const status = record.slice(record.lastIndexOf(" ") + 1);
      const hasTwoPaths = status.startsWith("R") || status.startsWith("C");
      index += hasTwoPaths ? 2 : 1;
      kinds.set(records[index] ?? "", KIND_BY_RAW_STATUS[status[0] ?? ""] ?? "modified");
      continue;
    }

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

    const binary = counts[1] === "-" && counts[2] === "-";
    files.push({
      path,
      ...(previousPath === undefined ? {} : { previousPath }),
      additions: counts[1] === "-" ? 0 : Number(counts[1]),
      deletions: counts[2] === "-" ? 0 : Number(counts[2]),
      ...(binary ? { binary: true as const } : {}),
    });
  }

  return files
    .map((file) => ({ ...file, kind: kinds.get(file.path) ?? "modified" }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

export function isGitImport(
  file: TurnDiffFileSummary,
  authoredPaths: ReadonlySet<string> | null,
): boolean {
  return (
    authoredPaths !== null &&
    !authoredPaths.has(file.path) &&
    (file.previousPath === undefined || !authoredPaths.has(file.previousPath))
  );
}
