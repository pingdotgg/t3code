import type { ProjectEntry } from "@t3tools/contracts";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

export const PROJECT_FILE_PICKER_RESULT_LIMIT = 200;

export interface ProjectFilePickerMatch {
  readonly name: string;
  readonly nameMatchIndices: ReadonlyArray<number>;
  readonly path: string;
  readonly pathMatchIndices: ReadonlyArray<number>;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Return null for unmatched subsequences; server-matched entries still render without highlights. */
function findMatchIndices(value: string, queryChars: ReadonlyArray<string>): number[] | null {
  if (queryChars.length === 0) return [];

  // Whole-string lowercasing preserves context-sensitive rules like Greek final sigma (Σ → ς);
  // lowercasing lengthens İ (to i̇) and shortens nothing, so only a length change needs mapping back.
  const normalizedValue = value.toLowerCase();
  const sourceSpans: Array<readonly [number, number]> = [];
  if (normalizedValue.length !== value.length) {
    let sourceOffset = 0;
    for (const char of value) {
      const span = [sourceOffset, sourceOffset + char.length] as const;
      for (let n = char.toLowerCase().length; n > 0; n -= 1) sourceSpans.push(span);
      sourceOffset = span[1];
    }
  }

  const indices: number[] = [];
  let queryIndex = 0;
  let offset = 0;

  for (const char of normalizedValue) {
    if (char === queryChars[queryIndex]) {
      const [start, end] = sourceSpans[offset] ?? [offset, offset + char.length];
      for (let i = Math.max(start, (indices.at(-1) ?? -1) + 1); i < end; i += 1) indices.push(i);
      queryIndex += 1;
      if (queryIndex === queryChars.length) return indices;
    }
    offset += char.length;
  }

  return null;
}

export function groupMatchRanges(
  indices: ReadonlyArray<number>,
): Array<readonly [start: number, end: number]> {
  const ranges: Array<[number, number]> = [];
  for (const index of indices) {
    const previous = ranges.at(-1);
    if (previous && previous[1] === index) {
      previous[1] = index + 1;
    } else {
      ranges.push([index, index + 1]);
    }
  }
  return ranges;
}

/** Preserve server ranking and query normalization while filtering files and computing highlights. */
export function getProjectFilePickerMatches(
  entries: ReadonlyArray<ProjectEntry>,
  rawQuery: string,
  limit = PROJECT_FILE_PICKER_RESULT_LIMIT,
): ProjectFilePickerMatch[] {
  if (limit <= 0) return [];

  const queryChars = Array.from(
    normalizeSearchQuery(rawQuery, {
      trimLeadingPattern: /^[@./]+/,
    }).replaceAll(/\s/g, ""),
  );
  const matches: ProjectFilePickerMatch[] = [];

  for (const entry of entries) {
    if (entry.kind !== "file") continue;

    const name = fileName(entry.path);
    const nameMatchIndices = findMatchIndices(name, queryChars);
    const pathMatchIndices = findMatchIndices(entry.path, queryChars);
    matches.push({
      name,
      nameMatchIndices: nameMatchIndices ?? [],
      path: entry.path,
      pathMatchIndices: pathMatchIndices ?? [],
    });
    if (matches.length >= limit) break;
  }

  return matches;
}
