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

export interface WorkspaceActivity {
  readonly ranCommands: boolean;
  readonly editedPaths: ReadonlyArray<string>;
  readonly otherThreadsWorked: boolean;
  readonly otherThreadsEditedPaths: ReadonlyArray<string>;
}

// Diff paths are repository-relative; providers report paths absolute or relative to the cwd.
function namesDiffPath(cwd: string, editedPath: string, diffPath: string): boolean {
  const normalizedCwd = cwd.replaceAll("\\", "/");
  const root = normalizedCwd.endsWith("/") ? normalizedCwd : `${normalizedCwd}/`;
  let edited = editedPath.replaceAll("\\", "/");
  if (edited.startsWith(root)) edited = edited.slice(root.length);
  else if (edited.startsWith("/") || /^[A-Za-z]:\//.test(edited)) {
    return edited.endsWith(`/${diffPath}`);
  }
  edited = edited.replace(/^(\.\/)+/, "");
  return edited === diffPath || diffPath.endsWith(`/${edited}`);
}

/** A change another thread in a shared checkout made, which this run neither edited nor could have. */
export function isOtherThreadsChange(
  file: TurnDiffFileSummary,
  cwd: string,
  activity: WorkspaceActivity,
): boolean {
  const named = (paths: ReadonlyArray<string>) =>
    paths.some(
      (path) =>
        namesDiffPath(cwd, path, file.path) ||
        (file.previousPath !== undefined && namesDiffPath(cwd, path, file.previousPath)),
    );
  return (
    activity.otherThreadsWorked &&
    !named(activity.editedPaths) &&
    (!activity.ranCommands || named(activity.otherThreadsEditedPaths))
  );
}
