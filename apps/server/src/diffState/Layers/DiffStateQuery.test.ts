import { ThreadId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { CheckpointUnavailableError } from "../../checkpointing/Errors.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import { DiffStateQuery } from "../Services/DiffStateQuery.ts";
import { DiffStateQueryLayer } from "./DiffStateQuery.ts";

const threadId = ThreadId.make("thread-1");

function withCheckpointDiffQuery(checkpointDiffQuery: CheckpointDiffQueryShape) {
  return DiffStateQueryLayer.pipe(
    Layer.provideMerge(Layer.succeed(CheckpointDiffQuery, checkpointDiffQuery)),
  );
}

describe("DiffStateQueryLive", () => {
  it("returns a typed ready snapshot for turn diffs", async () => {
    const layer = withCheckpointDiffQuery({
      getTurnDiff: () =>
        Effect.succeed({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff: [
            "diff --git a/src/app.ts b/src/app.ts",
            "index 1111111..2222222 100644",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1 +1,2 @@",
            "-old",
            "+new",
            "+line",
          ].join("\n"),
        }),
      getFullThreadDiff: () => Effect.die("getFullThreadDiff should not be called"),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* DiffStateQuery;
        return yield* query.getTurnDiffState({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          scope: "turn",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result._tag).toBe("ready");
    if (result._tag !== "ready") {
      throw new Error("expected ready diff state");
    }
    expect(result.snapshot.scope).toBe("turn");
    expect(result.snapshot.metadata).toEqual({
      filesChanged: 1,
      totalAdditions: 2,
      totalDeletions: 1,
      largeFiles: 0,
      unrenderableFiles: 0,
    });
    expect(result.snapshot.files).toEqual([
      {
        path: "src/app.ts",
        previousPath: null,
        status: "unknown",
        additions: 2,
        deletions: 1,
        hunks: [],
        isBinary: false,
        size: "normal",
        hasHiddenBidiChars: false,
      },
    ]);
  });

  it("classifies binary files as unrenderable", async () => {
    const layer = withCheckpointDiffQuery({
      getTurnDiff: () =>
        Effect.succeed({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff: [
            "diff --git a/assets/icon.png b/assets/icon.png",
            "index 1111111..2222222 100644",
            "Binary files a/assets/icon.png and b/assets/icon.png differ",
          ].join("\n"),
        }),
      getFullThreadDiff: () => Effect.die("getFullThreadDiff should not be called"),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* DiffStateQuery;
        return yield* query.getTurnDiffState({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          scope: "turn",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result._tag).toBe("ready");
    if (result._tag !== "ready") {
      throw new Error("expected ready diff state");
    }
    expect(result.snapshot.files[0]?.isBinary).toBe(true);
    expect(result.snapshot.files[0]?.size).toBe("unrenderable");
    expect(result.snapshot.metadata.unrenderableFiles).toBe(1);
  });

  it("classifies very long lines as large and detects hidden bidi chars", async () => {
    const layer = withCheckpointDiffQuery({
      getTurnDiff: () =>
        Effect.succeed({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff: [
            "diff --git a/src/app.ts b/src/app.ts",
            "index 1111111..2222222 100644",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1 +1 @@",
            `+${"x".repeat(5_001)}\u202E`,
          ].join("\n"),
        }),
      getFullThreadDiff: () => Effect.die("getFullThreadDiff should not be called"),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* DiffStateQuery;
        return yield* query.getTurnDiffState({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          scope: "turn",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result._tag).toBe("ready");
    if (result._tag !== "ready") {
      throw new Error("expected ready diff state");
    }
    expect(result.snapshot.files[0]?.size).toBe("large");
    expect(result.snapshot.files[0]?.hasHiddenBidiChars).toBe(true);
    expect(result.snapshot.metadata.largeFiles).toBe(1);
  });

  it("returns unavailable state for missing checkpoint refs", async () => {
    const layer = withCheckpointDiffQuery({
      getTurnDiff: () =>
        Effect.fail(
          new CheckpointUnavailableError({
            threadId,
            turnCount: 2,
            detail: "Filesystem checkpoint is unavailable for turn 2.",
          }),
        ),
      getFullThreadDiff: () => Effect.die("getFullThreadDiff should not be called"),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* DiffStateQuery;
        return yield* query.getTurnDiffState({
          threadId,
          fromTurnCount: 1,
          toTurnCount: 2,
          scope: "snapshot",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({
      _tag: "unavailable",
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      scope: "snapshot",
      message: "Filesystem checkpoint is unavailable for turn 2.",
    });
  });

  it("maps full-thread diffs to snapshot scope", async () => {
    const layer = withCheckpointDiffQuery({
      getTurnDiff: () => Effect.die("getTurnDiff should not be called"),
      getFullThreadDiff: () =>
        Effect.succeed({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 3,
          diff: "",
        }),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* DiffStateQuery;
        return yield* query.getFullThreadDiffState({
          threadId,
          toTurnCount: 3,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({
      _tag: "ready",
      snapshot: {
        threadId,
        fromTurnCount: 0,
        toTurnCount: 3,
        scope: "snapshot",
        patch: "",
        metadata: {
          filesChanged: 0,
          totalAdditions: 0,
          totalDeletions: 0,
          largeFiles: 0,
          unrenderableFiles: 0,
        },
        files: [],
      },
    });
  });

  it("computes a single file delta from the active turn diff", async () => {
    const layer = withCheckpointDiffQuery({
      getTurnDiff: () =>
        Effect.succeed({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff: [
            "diff --git a/src/a.ts b/src/a.ts",
            "index 1111111..2222222 100644",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "diff --git a/src/b.ts b/src/b.ts",
            "index 3333333..4444444 100644",
            "--- a/src/b.ts",
            "+++ b/src/b.ts",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "+line",
          ].join("\n"),
        }),
      getFullThreadDiff: () => Effect.die("getFullThreadDiff should not be called"),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* DiffStateQuery;
        return yield* query.getTurnDiffFileDelta({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          scope: "turn",
          path: "src/b.ts",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.path).toBe("src/b.ts");
    expect(result.file?.path).toBe("src/b.ts");
    expect(result.file?.additions).toBe(2);
    expect(result.metadata.filesChanged).toBe(2);
  });
});
