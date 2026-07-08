import type {
  DiffFile,
  DiffFileDelta,
  DiffMetadata,
  DiffSize,
  DiffSnapshot,
  DiffState,
  OrchestrationGetTurnDiffResult,
  TurnDiffScope,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { CheckpointDiffQueryLive } from "../../checkpointing/Layers/CheckpointDiffQuery.ts";
import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointDiffQuery } from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import { DiffStateQuery, type DiffStateQueryShape } from "../Services/DiffStateQuery.ts";

const MAX_DIFF_SIZE = 4_375_000;
const MAX_REASONABLE_DIFF_SIZE = 2_187_500;
const MAX_CHARACTERS_PER_LINE = 5_000;
const DIFF_LINE_RENDER_LIMIT = 10_000;
const DELETION_LINE_RENDER_LIMIT = 8_000;
const BIDI_CHARS = /[\u202A-\u202E\u2066-\u2069]/u;

function summarizeFiles(files: ReadonlyArray<DiffFile>): DiffMetadata {
  return {
    filesChanged: files.length,
    totalAdditions: files.reduce((total, file) => total + file.additions, 0),
    totalDeletions: files.reduce((total, file) => total + file.deletions, 0),
    largeFiles: files.filter((file) => file.size === "large").length,
    unrenderableFiles: files.filter((file) => file.size === "unrenderable").length,
  };
}

function parseDiffHeaderPath(rawPath: string): string {
  if (rawPath === "/dev/null") {
    return rawPath;
  }
  if (rawPath.startsWith("a/") || rawPath.startsWith("b/")) {
    return rawPath.slice(2);
  }
  return rawPath;
}

function parseDiffSectionPath(section: string): string | null {
  const header = section.match(/^diff --git\s+(.+?)\s+(.+)$/m);
  if (!header) {
    return null;
  }

  const nextPath = parseDiffHeaderPath(header[2] ?? "");
  if (nextPath !== "/dev/null") {
    return nextPath;
  }
  const previousPath = parseDiffHeaderPath(header[1] ?? "");
  return previousPath === "/dev/null" ? null : previousPath;
}

function splitPatchByFile(patch: string): Map<string, string> {
  const sections = new Map<string, string>();
  const starts = [...patch.matchAll(/^diff --git .+$/gm)].map((match) => match.index ?? 0);
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index] ?? 0;
    const end = starts[index + 1] ?? patch.length;
    const section = patch.slice(start, end);
    const filePath = parseDiffSectionPath(section);
    if (filePath) {
      sections.set(filePath, section);
    }
  }
  return sections;
}

function classifyDiffSection(input: {
  readonly section: string;
  readonly additions: number;
  readonly deletions: number;
}): { readonly size: DiffSize; readonly isBinary: boolean; readonly hasHiddenBidiChars: boolean } {
  const isBinary =
    input.section.includes("GIT binary patch") ||
    input.section
      .split("\n")
      .some((line) => line.startsWith("Binary files ") && line.includes(" differ"));
  const hasHiddenBidiChars = BIDI_CHARS.test(input.section);
  const hasVeryLongLine = input.section
    .split("\n")
    .some((line) => line.length > MAX_CHARACTERS_PER_LINE);

  if (
    isBinary ||
    input.section.length > MAX_DIFF_SIZE ||
    input.deletions > DELETION_LINE_RENDER_LIMIT
  ) {
    return { size: "unrenderable", isBinary, hasHiddenBidiChars };
  }
  if (
    input.section.length >= MAX_REASONABLE_DIFF_SIZE ||
    hasVeryLongLine ||
    input.additions > DIFF_LINE_RENDER_LIMIT ||
    input.deletions > DIFF_LINE_RENDER_LIMIT
  ) {
    return { size: "large", isBinary, hasHiddenBidiChars };
  }
  return { size: "normal", isBinary, hasHiddenBidiChars };
}

function countUnifiedDiffSectionChanges(section: string): {
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of section.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function toDiffFiles(patch: string): ReadonlyArray<DiffFile> {
  if (patch.trim().length === 0) {
    return [];
  }

  const sectionsByPath = splitPatchByFile(patch);
  const parsedFilesByPath = new Map(
    parseTurnDiffFilesFromUnifiedDiff(patch).map((file) => [file.path, file] as const),
  );
  for (const path of sectionsByPath.keys()) {
    if (!parsedFilesByPath.has(path)) {
      parsedFilesByPath.set(path, {
        path,
        additions: 0,
        deletions: 0,
      });
    }
  }

  return [...parsedFilesByPath.values()]
    .toSorted((left, right) => left.path.localeCompare(right.path))
    .map((file) => {
      const section = sectionsByPath.get(file.path) ?? "";
      const changes =
        section.length > 0
          ? countUnifiedDiffSectionChanges(section)
          : { additions: file.additions, deletions: file.deletions };
      const classification = classifyDiffSection({
        section,
        additions: changes.additions,
        deletions: changes.deletions,
      });
      return {
        path: file.path,
        previousPath: null,
        status: "unknown",
        additions: changes.additions,
        deletions: changes.deletions,
        hunks: [],
        size: classification.size,
        isBinary: classification.isBinary,
        hasHiddenBidiChars: classification.hasHiddenBidiChars,
      };
    });
}

function toReadyDiffState(input: {
  readonly result: OrchestrationGetTurnDiffResult;
  readonly scope: TurnDiffScope;
}): DiffState {
  const files = toDiffFiles(input.result.diff);
  const snapshot: DiffSnapshot = {
    threadId: input.result.threadId,
    fromTurnCount: input.result.fromTurnCount,
    toTurnCount: input.result.toTurnCount,
    scope: input.scope,
    patch: input.result.diff,
    files,
    metadata: summarizeFiles(files),
  };

  return {
    _tag: "ready",
    snapshot,
  };
}

function toFileDelta(input: {
  readonly state: DiffState;
  readonly path: string;
}): DiffFileDelta | null {
  if (input.state._tag !== "ready" && input.state._tag !== "stale") {
    return null;
  }
  const snapshot = input.state.snapshot;
  return {
    threadId: snapshot.threadId,
    fromTurnCount: snapshot.fromTurnCount,
    toTurnCount: snapshot.toTurnCount,
    scope: snapshot.scope,
    path: input.path,
    file: snapshot.files.find((file) => file.path === input.path) ?? null,
    metadata: snapshot.metadata,
  };
}

const make = Effect.gen(function* () {
  const checkpointDiffQuery = yield* CheckpointDiffQuery;

  const getTurnDiffState: DiffStateQueryShape["getTurnDiffState"] = (input) => {
    const scope = input.scope ?? "snapshot";
    return checkpointDiffQuery.getTurnDiff({ ...input, scope }).pipe(
      Effect.map((result) => toReadyDiffState({ result, scope })),
      Effect.catchTag("CheckpointUnavailableError", (error) =>
        Effect.succeed({
          _tag: "unavailable" as const,
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          scope,
          message: error.detail,
        }),
      ),
    );
  };

  const getFullThreadDiffState: DiffStateQueryShape["getFullThreadDiffState"] = (input) =>
    checkpointDiffQuery.getFullThreadDiff(input).pipe(
      Effect.map((result) => toReadyDiffState({ result, scope: "snapshot" })),
      Effect.catchTag("CheckpointUnavailableError", (error) =>
        Effect.succeed({
          _tag: "unavailable" as const,
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: input.toTurnCount,
          scope: "snapshot" as const,
          message: error.detail,
        }),
      ),
    );

  const getTurnDiffFileDelta: DiffStateQueryShape["getTurnDiffFileDelta"] = (input) =>
    getTurnDiffState(input).pipe(
      Effect.map((state) => {
        const delta = toFileDelta({ state, path: input.path });
        if (delta) {
          return delta;
        }
        return {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          scope: input.scope ?? "snapshot",
          path: input.path,
          file: null,
          metadata: {
            filesChanged: 0,
            totalAdditions: 0,
            totalDeletions: 0,
            largeFiles: 0,
            unrenderableFiles: 0,
          },
        };
      }),
    );

  return {
    getTurnDiffState,
    getFullThreadDiffState,
    getTurnDiffFileDelta,
  } satisfies DiffStateQueryShape;
});

export const DiffStateQueryLayer = Layer.effect(DiffStateQuery, make);

export const DiffStateQueryLive = DiffStateQueryLayer.pipe(
  Layer.provide(CheckpointDiffQueryLive),
  Layer.provide(CheckpointStoreLive),
);
