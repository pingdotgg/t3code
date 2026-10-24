import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { FileDiffMetadata } from "@pierre/diffs/types";
import { parseReviewDiffFromFiles } from "./reviewDiffMetadata.ts";
import * as Hash from "effect/Hash";
import { orderReviewFiles } from "./reviewWorkspace.ts";
import { projectReviewDiffContext, UNKNOWN_REVIEW_LINE } from "./reviewDiffContext.ts";

const resolveFileDiffPath = (file: FileDiffMetadata) => file.name;

type Scope = "staged" | "unstaged";
export type WorkingChangesSnapshot = {
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly hunksByPath: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Cleared comparisons stay open in the reader, but never appear in the Git tree. */
  readonly retainedFiles?: ReadonlyArray<FileDiffMetadata>;
};
export type WorkingChangesState = Record<Scope, WorkingChangesSnapshot>;

function patchHunks(patches: ReadonlyArray<string>) {
  return patches.flatMap((patch) =>
    patch
      .split(/(?=^@@ )/m)
      .slice(1)
      .map((text) => {
        const lines = text.replace(/\n$/, "").split("\n");
        const header = lines[0]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)!;
        const before: string[] = [];
        const after: string[] = [];
        let previousSign = "";
        for (const line of lines.slice(1)) {
          if (line.startsWith(" ") || line.startsWith("-")) before.push(`${line.slice(1)}\n`);
          if (line.startsWith(" ") || line.startsWith("+")) after.push(`${line.slice(1)}\n`);
          if (line.startsWith("\\")) {
            if (before.length && previousSign !== "+")
              before[before.length - 1] = before.at(-1)!.replace(/\n$/, "");
            if (after.length && previousSign !== "-")
              after[after.length - 1] = after.at(-1)!.replace(/\n$/, "");
          } else previousSign = line[0] ?? "";
        }
        return {
          oldAt: Number(header[1]) - (Number(header[2] ?? 1) === 0 ? 0 : 1),
          newAt: Number(header[3]) - (Number(header[4] ?? 1) === 0 ? 0 : 1),
          before,
          after,
        };
      }),
  );
}

function applyPatch(lines: ReadonlyArray<string>, patches: ReadonlyArray<string>, reverse = false) {
  const next = [...lines];
  for (const hunk of patchHunks(patches).sort((a, b) =>
    reverse ? b.newAt - a.newAt : b.oldAt - a.oldAt,
  )) {
    next.splice(
      reverse ? hunk.newAt : hunk.oldAt,
      reverse ? hunk.after.length : hunk.before.length,
      ...(reverse ? hunk.before : hunk.after),
    );
  }
  return next;
}

function optimisticFile(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
  fallback: FileDiffMetadata,
  header: string,
  anchorSide: "additions" | "deletions",
  retainContext = true,
) {
  const contextFile = projectReviewDiffContext(before, after, fallback, anchorSide);
  if (before.join("") === after.join("")) return { file: null, hunks: [], contextFile };
  // Unknown unchanged lines establish coordinates only. Zero context prevents them from
  // entering the optimistic render or a staging patch; Git supplies real context on refresh.
  const generated = parseReviewDiffFromFiles(
    { name: fallback.name, contents: before.join("") },
    { name: fallback.name, contents: after.join("") },
    { context: 0 },
  );
  const encodeLine = (sign: string, line: string) =>
    `${sign}${line}${line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`;
  const hunks = generated.hunks.map((hunk) => {
    const body = hunk.hunkContent
      .map((content) =>
        content.type === "change"
          ? generated.deletionLines
              .slice(content.deletionLineIndex, content.deletionLineIndex + content.deletions)
              .map((line) => encodeLine("-", line))
              .join("") +
            generated.additionLines
              .slice(content.additionLineIndex, content.additionLineIndex + content.additions)
              .map((line) => encodeLine("+", line))
              .join("")
          : generated.additionLines
              .slice(content.additionLineIndex, content.additionLineIndex + content.lines)
              .map((line) => encodeLine(" ", line))
              .join(""),
      )
      .join("");
    return `${header}${hunk.hunkSpecs}\n${body}`;
  });
  const patch = header + hunks.map((hunk) => hunk.slice(header.length)).join("");
  const file = parsePatchFiles(patch, `optimistic:${Hash.string(patch)}`)[0]?.files[0];
  return file
    ? {
        file: retainContext ? contextFile : file,
        hunks,
        contextFile,
      }
    : null;
}

function stagePatch(
  current: WorkingChangesState,
  path: string,
  patch: string,
  scope: Scope,
  fallback: FileDiffMetadata,
  revert = false,
  retainContext = true,
) {
  const staged = current.staged.hunksByPath.get(path) ?? [];
  const unstaged = current.unstaged.hunksByPath.get(path) ?? [];
  const known = new Map<number, string>();
  for (const hunk of patchHunks(staged))
    hunk.after.forEach((line, at) => known.set(hunk.newAt + at, line));
  for (const hunk of patchHunks(unstaged))
    hunk.before.forEach((line, at) => known.set(hunk.oldAt + at, line));
  // Pierre upgrades metadata in place after expanding context. Use those contents
  // too, so staging preserves the expanded file rather than a fresh partial patch.
  if (!fallback.isPartial) {
    const lines = scope === "unstaged" ? fallback.deletionLines : fallback.additionLines;
    lines.forEach((line, at) => known.set(at, line));
  } else {
    for (const hunk of fallback.hunks) {
      const start = scope === "unstaged" ? hunk.deletionStart : hunk.additionStart;
      const at = scope === "unstaged" ? hunk.deletionLineIndex : hunk.additionLineIndex;
      const count = scope === "unstaged" ? hunk.deletionCount : hunk.additionCount;
      const lines = scope === "unstaged" ? fallback.deletionLines : fallback.additionLines;
      const noEOF = scope === "unstaged" ? hunk.noEOFCRDeletions : hunk.noEOFCRAdditions;
      lines
        .slice(at, at + count)
        .forEach((line, offset) =>
          known.set(
            start - 1 + offset,
            line.endsWith("\n") || (noEOF && offset === count - 1) ? line : `${line}\n`,
          ),
        );
    }
  }
  let lineCount = 0;
  for (const at of known.keys()) lineCount = Math.max(lineCount, at + 1);
  const index = Array.from(
    { length: lineCount },
    (_, at) => known.get(at) ?? `${UNKNOWN_REVIEW_LINE}${at}\n`,
  );
  const head = applyPatch(index, staged, true);
  const working = applyPatch(index, unstaged);
  const nextIndex = revert ? index : applyPatch(index, [patch], scope === "staged");
  const nextWorking = revert ? applyPatch(working, [patch], true) : working;
  const header = patch.split(/(?=^@@ )/m)[0]!;
  return {
    staged: optimisticFile(
      head,
      nextIndex,
      current.staged.files.find((file) => resolveFileDiffPath(file) === path) ?? fallback,
      header,
      scope === "staged" ? "deletions" : "additions",
      retainContext,
    ),
    unstaged: optimisticFile(
      nextIndex,
      nextWorking,
      current.unstaged.files.find((file) => resolveFileDiffPath(file) === path) ?? fallback,
      header,
      revert ? "deletions" : "additions",
      retainContext,
    ),
  };
}

/** Keep both Git sections and their rendered diffs ahead of the mutation response. */
export function applyWorkingChangesMutation(
  current: WorkingChangesState,
  combined: WorkingChangesSnapshot,
  mutation: {
    scope: Scope;
    paths: ReadonlyArray<string>;
    patch?: string;
    revert?: boolean;
    retainContext?: boolean;
  },
): WorkingChangesState {
  const destination = mutation.scope === "staged" ? "unstaged" : "staged";
  const paths = new Set(mutation.paths);
  const affected = current[mutation.scope].files.filter(
    (file) => paths.has(resolveFileDiffPath(file)) || (file.prevName && paths.has(file.prevName)),
  );
  const sourceFiles = new Map(
    current[mutation.scope].files.map((file) => [resolveFileDiffPath(file), file]),
  );
  const destinationFiles = new Map(
    current[destination].files.map((file) => [resolveFileDiffPath(file), file]),
  );
  const sourceHunks = new Map(current[mutation.scope].hunksByPath);
  const destinationHunks = new Map(current[destination].hunksByPath);
  const retainedFiles = new Map(
    (current[mutation.scope].retainedFiles ?? []).map((file) => [resolveFileDiffPath(file), file]),
  );
  for (const file of affected) {
    const path = resolveFileDiffPath(file);
    if (mutation.patch) {
      const changed = stagePatch(
        current,
        path,
        mutation.patch,
        mutation.scope,
        file,
        mutation.revert,
        mutation.retainContext,
      );
      const source = changed[mutation.scope];
      const target = changed[destination];
      if (source?.file) sourceFiles.set(path, source.file);
      else sourceFiles.delete(path);
      if (source) retainedFiles.set(path, source.contextFile);
      sourceHunks.set(path, source?.hunks ?? []);
      if (!mutation.revert) {
        if (target?.file) destinationFiles.set(path, target.file);
        else destinationFiles.delete(path);
        destinationHunks.set(path, target?.hunks ?? []);
      }
    } else {
      sourceFiles.delete(path);
      sourceHunks.delete(path);
      const raw = current[mutation.scope].hunksByPath.get(path) ?? [];
      const header = raw[0]?.split(/(?=^@@ )/m)[0];
      const changed = header
        ? stagePatch(
            current,
            path,
            header + raw.map((hunk) => hunk.slice(hunk.indexOf("@@ "))).join(""),
            mutation.scope,
            file,
            mutation.revert,
            mutation.retainContext,
          )
        : null;
      const cleared = changed?.[mutation.scope]?.contextFile;
      if (cleared) retainedFiles.set(path, cleared);
      if (!mutation.revert) {
        const complete = combined.files.find(
          (candidate) =>
            resolveFileDiffPath(candidate) === path && !candidate.cacheKey?.endsWith(":pending"),
        );
        if (changed) {
          const target = changed[destination]?.file;
          if (target) destinationFiles.set(path, target);
          else destinationFiles.delete(path);
        } else destinationFiles.set(path, complete ?? file);
        destinationHunks.set(
          path,
          changed?.[destination]?.hunks ?? combined.hunksByPath.get(path) ?? raw,
        );
      }
    }
  }
  const source = {
    files: orderReviewFiles([...sourceFiles.values()], resolveFileDiffPath),
    hunksByPath: sourceHunks,
    retainedFiles: [...retainedFiles.values()],
  };
  const target = {
    files: orderReviewFiles([...destinationFiles.values()], resolveFileDiffPath),
    hunksByPath: destinationHunks,
  };
  return {
    staged: mutation.scope === "staged" ? source : target,
    unstaged: mutation.scope === "unstaged" ? source : target,
  };
}
