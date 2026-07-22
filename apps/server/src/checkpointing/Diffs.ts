import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
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

function stripGitPathQuoting(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1)
    : value;
}

/**
 * Extract the post-image path of one `diff --git` section, preferring the
 * `+++ b/` line and falling back to `--- a/` for deletions. Returns null when
 * the section is unparseable; callers should keep such sections.
 */
function resolveDiffSectionPath(section: string): string | null {
  // `--- a/` precedes `+++ b/` in a section, so resolve the post-image path
  // in a full pass before falling back — for renames the two differ, and the
  // attribution map is keyed by the post-image path.
  let fallbackSource: string | null = null;
  for (const line of section.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = stripGitPathQuoting(line.slice(4).trim());
      if (target !== "/dev/null") {
        return target.startsWith("b/") ? target.slice(2) : target;
      }
    } else if (line.startsWith("--- ") && fallbackSource === null) {
      const source = stripGitPathQuoting(line.slice(4).trim());
      if (source !== "/dev/null" && source.startsWith("a/")) {
        fallbackSource = source.slice(2);
      }
    }
  }
  return fallbackSource;
}

/**
 * Remove file sections from a unified diff by path.
 *
 * Sections whose path cannot be determined are kept (fail toward showing).
 */
export function filterUnifiedDiffFiles(
  diff: string,
  shouldKeepPath: (path: string) => boolean,
): string {
  const normalized = diff.replace(/\r\n/g, "\n");
  if (normalized.trim().length === 0) {
    return diff;
  }

  const sections: Array<string> = [];
  let currentStart = -1;
  const lines = normalized.split("\n");
  const flush = (endExclusive: number) => {
    if (currentStart >= 0) {
      sections.push(lines.slice(currentStart, endExclusive).join("\n"));
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.startsWith("diff --git ")) {
      flush(index);
      currentStart = index;
    }
  }
  flush(lines.length);
  if (sections.length === 0) {
    return diff;
  }

  const kept = sections.filter((section) => {
    const path = resolveDiffSectionPath(section);
    return path === null || shouldKeepPath(path);
  });
  if (kept.length === sections.length) {
    return diff;
  }
  return kept.join("\n");
}
