export interface TurnDiffFileSummary {
  readonly path: string;
  readonly previousPath?: string;
  readonly additions?: number;
  readonly deletions?: number;
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
      ...(counts[1] === "-" ? {} : { additions: Number(counts[1]) }),
      ...(counts[2] === "-" ? {} : { deletions: Number(counts[2]) }),
    });
  }

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

export function parseTurnDiffFilesFromSummary(summary: string) {
  const records = summary.split("\0");
  const kinds = new Map<string, string>();
  let index = 0;
  while (records[index]?.startsWith(":")) {
    const status = records[index]!.split(" ").at(-1)?.[0];
    index += 1;
    let path = records[index++];
    if (status === "R" || status === "C") path = records[index++];
    if (path === undefined) break;
    kinds.set(
      path,
      status === "A" || status === "C"
        ? "added"
        : status === "D"
          ? "deleted"
          : status === "R"
            ? "renamed"
            : "modified",
    );
  }
  return parseTurnDiffFilesFromNumstat(records.slice(index).join("\0")).map((file) => ({
    ...file,
    kind: kinds.get(file.path) ?? "modified",
  }));
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
