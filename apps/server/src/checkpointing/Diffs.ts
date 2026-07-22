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
  if (!(value.startsWith('"') && value.endsWith('"') && value.length >= 2)) {
    return value;
  }
  // Git C-style quoting: decode the escapes it emits for unusual paths.
  return value.slice(1, -1).replace(/\\([\\"abfnrtv]|[0-7]{1,3})/g, (_, escape: string) => {
    switch (escape) {
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "a":
        return "\x07";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "v":
        return "\v";
      default:
        return String.fromCharCode(parseInt(escape, 8));
    }
  });
}

/**
 * Parse the post-image path out of a `diff --git a/<path> b/<path>` header.
 *
 * Only trustworthy when both paths are quoted or the two paths are equal
 * (no rename): for unquoted renamed paths containing spaces the split is
 * ambiguous, so return null and let the caller keep the section.
 */
function resolveDiffGitHeaderPath(headerLine: string): string | null {
  const spec = headerLine.slice("diff --git ".length).trim();
  const quotedMatch = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(spec);
  if (quotedMatch) {
    const source = stripGitPathQuoting(quotedMatch[1]!);
    const target = stripGitPathQuoting(quotedMatch[2]!);
    if (source.startsWith("a/") && target.startsWith("b/")) {
      return target.slice(2);
    }
  }
  // Paths with spaces are unquoted in this header; recover the symmetric
  // a/X b/X form (covers everything but renames of space-containing paths).
  if (spec.length % 2 === 1) {
    const midpoint = (spec.length - 1) / 2;
    const source = spec.slice(0, midpoint);
    const target = spec.slice(midpoint + 1);
    if (source.startsWith("a/") && target.startsWith("b/") && source.slice(2) === target.slice(2)) {
      return target.slice(2);
    }
  }
  return null;
}

/**
 * Extract the post-image path of one `diff --git` section, preferring the
 * `+++ b/` line and falling back to `--- a/` for deletions. Binary and
 * mode-only sections have neither, so fall back to rename/copy metadata and
 * finally the `diff --git` header itself. Returns null when the section is
 * unparseable; callers should keep such sections.
 */
function resolveDiffSectionPath(section: string): string | null {
  // `--- a/` precedes `+++ b/` in a section, so resolve the post-image path
  // in a full pass before falling back — for renames the two differ, and the
  // attribution map is keyed by the post-image path.
  let fallbackSource: string | null = null;
  let renameTarget: string | null = null;
  let headerPath: string | null = null;
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
    } else if (
      (line.startsWith("rename to ") || line.startsWith("copy to ")) &&
      renameTarget === null
    ) {
      renameTarget = stripGitPathQuoting(line.slice(line.indexOf(" to ") + 4));
    } else if (line.startsWith("diff --git ") && headerPath === null) {
      headerPath = resolveDiffGitHeaderPath(line);
    }
  }
  return fallbackSource ?? renameTarget ?? headerPath;
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
