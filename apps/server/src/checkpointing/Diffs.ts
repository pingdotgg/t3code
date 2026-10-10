export interface TurnDiffFileSummary {
  readonly path: string;
  readonly previousPath?: string;
  readonly additions: number;
  readonly deletions: number;
}

/** Reads Git's NUL-delimited numstat output without decoding display paths. */
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
      // Renames and copies use two more records: the source and destination.
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

/**
 * True when Git brought this file in and no work in the range touched it.
 * `authoredPaths` comes from `CheckpointStore.listAuthoredPaths`; null means nothing was imported.
 * A rename stays visible when either side was authored, because the summary shows it as one file.
 */
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

/**
 * Moves every path in a NUL-delimited numstat under `prefix`, as if Git had run in the folder
 * that holds the repository. Used to merge the per-repository diffs of a multi-repo workspace.
 */
export function prefixNumstatPaths(numstat: string, prefix: string): string {
  const records = numstat.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(records[index]!);
    if (!counts) continue;
    const path = records[index]!.slice(counts[0].length);
    if (path.length > 0) {
      records[index] = `${counts[0]}${prefix}/${path}`;
      continue;
    }
    // Renames and copies use two more records: the source and destination.
    for (const pathIndex of [index + 1, index + 2]) {
      if (records[pathIndex]) records[pathIndex] = `${prefix}/${records[pathIndex]}`;
    }
    index += 2;
  }
  return records.join("\0");
}

/**
 * Moves every file header path in a unified Git patch under `prefix`. Hunk lines are left
 * alone, so content that happens to look like a header is never rewritten.
 */
export function prefixPatchPaths(patch: string, prefix: string): string {
  let inHeader = false;
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        inHeader = true;
        return prefixDiffGitLine(line, prefix);
      }
      if (!inHeader) return line;
      if (line.startsWith("@@")) {
        inHeader = false;
        return line;
      }
      return prefixPatchHeaderLine(line, prefix);
    })
    .join("\n");
}

// `a/x` -> `a/<prefix>/x`, keeping Git's optional C-style quotes.
function prefixSidePath(path: string, prefix: string): string {
  if (path.startsWith('"a/') || path.startsWith('"b/')) {
    return `${path.slice(0, 3)}${prefix}/${path.slice(3)}`;
  }
  if (path.startsWith("a/") || path.startsWith("b/")) {
    return `${path.slice(0, 2)}${prefix}/${path.slice(2)}`;
  }
  return path;
}

// `x` -> `<prefix>/x` for rename and copy headers, which carry no side marker.
function prefixBarePath(path: string, prefix: string): string {
  return path.startsWith('"') ? `"${prefix}/${path.slice(1)}` : `${prefix}/${path}`;
}

function prefixDiffGitLine(line: string, prefix: string): string {
  const paths = line.slice("diff --git ".length);
  // Paths may contain spaces. Unless renamed, both sides name the same file, so the line splits
  // in the middle; a rename's destination starts at the last ` b/` or ` "b/`.
  const middle = (paths.length - 1) / 2;
  const destination =
    paths[middle] === " " && paths.slice(2, middle) === paths.slice(middle + 3)
      ? middle
      : Math.max(paths.lastIndexOf(" b/"), paths.lastIndexOf(' "b/'));
  if (destination < 0) return line;
  return `diff --git ${prefixSidePath(paths.slice(0, destination), prefix)} ${prefixSidePath(
    paths.slice(destination + 1),
    prefix,
  )}`;
}

function prefixPatchHeaderLine(line: string, prefix: string): string {
  for (const marker of ["--- ", "+++ "]) {
    if (line.startsWith(marker)) return marker + prefixSidePath(line.slice(marker.length), prefix);
  }
  for (const marker of ["rename from ", "rename to ", "copy from ", "copy to "]) {
    if (line.startsWith(marker)) return marker + prefixBarePath(line.slice(marker.length), prefix);
  }
  const binary = /^Binary files (.+) and (.+) differ$/.exec(line);
  if (binary) {
    return `Binary files ${prefixSidePath(binary[1]!, prefix)} and ${prefixSidePath(
      binary[2]!,
      prefix,
    )} differ`;
  }
  return line;
}
