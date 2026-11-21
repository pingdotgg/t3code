import { turnDiffSections } from "@t3tools/client-runtime/state/thread-repositories";
import type { EnvironmentId, OrchestrationGetTurnDiffResult, ThreadId } from "@t3tools/contracts";
import { quoteGitPatchPath, unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  MAX_CACHED_REVIEW_DIFFS,
  MAX_CACHED_REVIEW_SOURCE_CHARACTERS,
} from "../features/review/reviewState";
const TRUNCATION_MARKER = /(?:\r?\n){1,2}\[truncated\]\s*$/;
const QUOTED_PATH = String.raw`"(?:[^"\\]|\\.)*"`;
const GIT_HEADER_PATHS = new RegExp(`^(${QUOTED_PATH}|a/.*?) (${QUOTED_PATH}|b/.*)$`);
const BINARY_FILES = new RegExp(
  `^Binary files (${QUOTED_PATH}|.+?) and (${QUOTED_PATH}|.+) differ$`,
);
const HEADER_PATH_LINES = [
  ["--- ", "a/"],
  ["+++ ", "b/"],
  ["rename from ", ""],
  ["rename to ", ""],
  ["copy from ", ""],
  ["copy to ", ""],
] as const;

function pathInFolder(token: string, folder: string, side: "a/" | "b/" | ""): string {
  const quoted = token.length >= 2 && token.startsWith('"') && token.endsWith('"');
  const path = quoted ? unquoteGitPatchPath(token) : token;
  if (path === "/dev/null" || !path.startsWith(side)) return token;
  return quoteGitPatchPath(`${side}${folder}/${path.slice(side.length)}`);
}

function gitHeaderPaths(paths: string): readonly [string, string] | null {
  // An unchanged name is repeated, which settles where a name holding " b/" ends.
  const middle = (paths.length - 1) / 2;
  if (
    Number.isInteger(middle) &&
    paths.startsWith("a/") &&
    paths.startsWith(" b/", middle) &&
    paths.slice(2, middle) === paths.slice(middle + 3)
  ) {
    return [paths.slice(0, middle), paths.slice(middle + 1)];
  }
  const match = GIT_HEADER_PATHS.exec(paths);
  return match ? [match[1]!, match[2]!] : null;
}

function patchInFolder(patch: string, folder: string): string {
  let inHeader = false;
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        inHeader = true;
        const paths = gitHeaderPaths(line.slice("diff --git ".length));
        return paths === null
          ? line
          : `diff --git ${pathInFolder(paths[0], folder, "a/")} ${pathInFolder(paths[1], folder, "b/")}`;
      }
      if (!inHeader) return line;
      if (line.startsWith("@@") || line === "GIT binary patch") {
        inHeader = false;
        return line;
      }
      for (const [lead, side] of HEADER_PATH_LINES) {
        if (!line.startsWith(lead)) continue;
        const tab = line.endsWith("\t") ? "\t" : "";
        const token = line.slice(lead.length, line.length - tab.length);
        return `${lead}${pathInFolder(token, folder, side)}${tab}`;
      }
      const binary = BINARY_FILES.exec(line);
      return binary
        ? // oxlint-disable-next-line t3code/no-untranslated-copy -- a line of Git patch text, parsed as a diff
          `Binary files ${pathInFolder(binary[1]!, folder, "a/")} and ${pathInFolder(binary[2]!, folder, "b/")} differ`
        : line;
    })
    .join("\n");
}

/**
 * A turn diff as the one patch review shows. Each tracked repository's files are renamed from
 * the thread's folder, so the same path in two repositories stays two files and a review comment
 * names a path the agent can open.
 */
export function reviewTurnDiffText(diff: Parameters<typeof turnDiffSections>[0]): string {
  const sections = turnDiffSections(diff, "");
  if (sections.every((section) => section.repositoryPath === null)) return diff.diff;
  let truncated = false;
  const patches = sections.map((section) => {
    const marker = TRUNCATION_MARKER.exec(section.diff);
    truncated ||= marker !== null;
    const text = marker === null ? section.diff : section.diff.slice(0, marker.index);
    const patch =
      section.relativePath === "" || section.relativePath === "."
        ? text
        : patchInFolder(text, section.relativePath);
    return patch.endsWith("\n") ? patch : `${patch}\n`;
  });
  return `${patches.join("")}${truncated ? "\n[truncated]" : ""}`;
}

const EMPTY_TURN_DIFFS = Object.freeze<Readonly<Record<number, string>>>({});

// The last answered diff of each single turn, keyed by its turn count, so review keeps showing
// turns it already loaded while the environment is disconnected and no turn query is mounted.
const lastTurnDiffsFamily = Atom.family((key: string) =>
  Atom.make(EMPTY_TURN_DIFFS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:turn-diffs:${key}`),
  ),
);

export function lastReviewTurnDiffsAtom(environmentId: EnvironmentId, threadId: ThreadId) {
  return lastTurnDiffsFamily(JSON.stringify([environmentId, threadId]));
}

// Integer keys enumerate in ascending order, so the lowest turn counts are evicted first.
const pruneTurnDiffs = (diffs: Readonly<Record<number, string>>) => {
  const turnCounts = Object.keys(diffs).map((key) => Number(key));
  let characters = turnCounts.reduce(
    (total, turnCount) => total + (diffs[turnCount]?.length ?? 0),
    0,
  );
  let dropped = 0;
  while (
    turnCounts.length - dropped > MAX_CACHED_REVIEW_DIFFS ||
    characters > MAX_CACHED_REVIEW_SOURCE_CHARACTERS
  ) {
    const oldest = turnCounts[dropped];
    if (oldest === undefined) break;
    characters -= diffs[oldest]?.length ?? 0;
    dropped += 1;
  }
  if (dropped === 0) return diffs;
  const kept: Record<number, string> = { ...diffs };
  for (const turnCount of turnCounts.slice(0, dropped)) {
    delete kept[turnCount];
  }
  return kept;
};

export const recordReviewTurnDiffAnswer = (
  target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly ignoreWhitespace?: boolean };
  },
  value: OrchestrationGetTurnDiffResult,
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.sync(() => {
    // Review shows one turn with whitespace changes; other ranges and whitespace-ignoring
    // reads are not what a review section displays.
    if (target.input.ignoreWhitespace === true || value.fromTurnCount !== value.toTurnCount - 1) {
      return;
    }
    const atom = lastReviewTurnDiffsAtom(target.environmentId, value.threadId);
    const current = registry.get(atom);
    const diff = reviewTurnDiffText(value);
    if (current[value.toTurnCount] === diff) return;
    // A diff larger than the whole budget never fits, so it is left out and the turns
    // already kept stay, the way the parsed diff cache leaves out one it cannot hold.
    if (diff.length > MAX_CACHED_REVIEW_SOURCE_CHARACTERS) return;
    registry.set(atom, pruneTurnDiffs({ ...current, [value.toTurnCount]: diff }));
  });
