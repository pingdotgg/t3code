import type {
  DiffFile,
  DiffFileDelta,
  DiffMetadata,
  DiffSize,
  DiffSnapshot,
  DiffState,
  OrchestrationGetTurnDiffResult,
  OrchestrationGetTurnDiffStateInput,
  TurnDiffScope,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { CheckpointDiffQueryLive } from "../../checkpointing/Layers/CheckpointDiffQuery.ts";
import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import {
  CheckpointDiffQuery,
  type TurnDiffPathsInput,
} from "../../checkpointing/Services/CheckpointDiffQuery.ts";
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

function classifyDiffSection(input: {
  readonly section: string;
  readonly additions: number;
  readonly deletions: number;
}): {
  readonly size: DiffSize;
  readonly isBinary: boolean;
  readonly hasHiddenBidiChars: boolean;
  readonly additions: number;
  readonly deletions: number;
} {
  let hasBinaryFilesLine = false;
  let hasVeryLongLine = false;
  let additions = 0;
  let deletions = 0;
  let lineStart = 0;
  while (lineStart < input.section.length) {
    const newlineIndex = input.section.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? input.section.length : newlineIndex;
    hasVeryLongLine ||= lineEnd - lineStart > MAX_CHARACTERS_PER_LINE;
    if (input.section.startsWith("+", lineStart) && !input.section.startsWith("+++", lineStart)) {
      additions += 1;
    } else if (
      input.section.startsWith("-", lineStart) &&
      !input.section.startsWith("---", lineStart)
    ) {
      deletions += 1;
    }
    if (!hasBinaryFilesLine && input.section.startsWith("Binary files ", lineStart)) {
      const differIndex = input.section.indexOf(" differ", lineStart);
      hasBinaryFilesLine = differIndex !== -1 && differIndex < lineEnd;
    }
    if (newlineIndex === -1) {
      break;
    }
    lineStart = newlineIndex + 1;
  }

  const isBinary = input.section.includes("GIT binary patch") || hasBinaryFilesLine;
  const hasHiddenBidiChars = BIDI_CHARS.test(input.section);
  const changes =
    input.section.length === 0
      ? { additions: input.additions, deletions: input.deletions }
      : { additions, deletions };

  if (
    isBinary ||
    input.section.length > MAX_DIFF_SIZE ||
    changes.deletions > DELETION_LINE_RENDER_LIMIT
  ) {
    return { size: "unrenderable", isBinary, hasHiddenBidiChars, ...changes };
  }
  if (
    input.section.length >= MAX_REASONABLE_DIFF_SIZE ||
    hasVeryLongLine ||
    changes.additions > DIFF_LINE_RENDER_LIMIT ||
    changes.deletions > DIFF_LINE_RENDER_LIMIT
  ) {
    return { size: "large", isBinary, hasHiddenBidiChars, ...changes };
  }
  return { size: "normal", isBinary, hasHiddenBidiChars, ...changes };
}

function toDiffFiles(patch: string): ReadonlyArray<DiffFile> {
  if (patch.trim().length === 0) {
    return [];
  }

  return parseTurnDiffFilesFromUnifiedDiff(patch).map((file) => {
    const classification = classifyDiffSection({
      section: file.section,
      additions: file.additions,
      deletions: file.deletions,
    });
    return {
      path: file.path,
      previousPath: file.previousPath,
      status: file.kind === "added" ? "new" : file.kind === "copied" ? "copied" : file.kind,
      additions: classification.additions,
      deletions: classification.deletions,
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

  const getTurnDiffState = (input: OrchestrationGetTurnDiffStateInput & TurnDiffPathsInput) => {
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
    getTurnDiffState({ ...input, paths: [input.path] }).pipe(
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
