import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import { CheckpointRef, CheckpointScopeId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import {
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
} from "./Errors.ts";

const threadId = ThreadId.make("thread:checkpoint-diff-v2");
const firstRunId = RunId.make("run:checkpoint-diff-v2:1");
const secondRunId = RunId.make("run:checkpoint-diff-v2:2");
const firstScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:1");
const secondScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:2");
const secondRef = CheckpointRef.make("refs/t3/test/second");

function makeProjection(): ProjectionCheckpointContext {
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: firstRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "root_run", cwd: "/repo" },
    ],
    checkpoints: [
      {
        scopeId: secondScopeId,
        runId: secondRunId,
        appRunOrdinal: 2,
        status: "ready",
        ref: secondRef,
      },
    ],
  };
}

function layerFor(input: {
  readonly projection: Effect.Effect<ProjectionCheckpointContext, OrchestratorProjectionError>;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
  readonly authoredPaths?: ReadonlySet<string>;
}) {
  return CheckpointDiffQuery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () => input.projection,
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          diffCheckpoints: input.diffCheckpoints ?? (() => Effect.succeed("diff")),
          listAuthoredPaths: () => Effect.succeed(input.authoredPaths ?? null),
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );
}

it.effect("computes V2 run diffs from projected checkpoint scopes", () => {
  const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("diff --git a/file b/file"),
  );
  const layer = layerFor({ projection: Effect.succeed(makeProjection()), diffCheckpoints });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });

    assert.deepEqual(result, {
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: "diff --git a/file b/file",
    });
    assert.deepEqual(diffCheckpoints.mock.calls[0]?.[0], {
      cwd: "/repo",
      fromCheckpointRef: yield* checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
      }),
      toCheckpointRef: secondRef,
      fallbackFromToHead: false,
      ignoreWhitespace: true,
      maxOutputBytes: 9_999_988,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("leaves Git imports out of large turn diffs", () => {
  const ownPaths = Array.from({ length: 1_000 }, (_, index) => `src/module-${index}/file.ts`);
  const diffCheckpoints = vi.fn((input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed(
      input.format === "numstat"
        ? [...ownPaths, "upstream.ts"].map((path) => `1\t0\t${path}\0`).join("")
        : (input.filePaths ?? ["all"]).join("\n"),
    ),
  );
  const layer = layerFor({
    projection: Effect.succeed(makeProjection()),
    diffCheckpoints,
    authoredPaths: new Set(ownPaths),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    for (const path of ownPaths) assert.include(result.diff, path);
    assert.notInclude(result.diff, "upstream.ts");
    assert.notInclude(result.diff, "[truncated]");

    const patchPaths = diffCheckpoints.mock.calls
      .map(([call]) => call)
      .filter((call) => call.format !== "numstat")
      .map((call) => call.filePaths ?? ["all"]);
    assert.isAbove(patchPaths.length, 1);
    assert.sameMembers(patchPaths.flat(), ownPaths);
  }).pipe(Effect.provide(layer));
});

it.effect.each(["x".repeat(10_000_000), "é".repeat(3_000_000)])(
  "caps filtered diffs across batches (case %#)",
  (firstPatch) => {
    const ownPaths = Array.from({ length: 2_000 }, (_, index) => `src/module-${index}/file.ts`);
    const allowances: number[] = [];
    const diffCheckpoints = (input: CheckpointStore.DiffCheckpointsInput) => {
      if (input.format === "numstat") {
        return Effect.succeed(
          [...ownPaths, "upstream.ts"].map((path) => `1\t0\t${path}\0`).join(""),
        );
      }
      allowances.push(input.maxOutputBytes ?? 10_000_000);
      const patch = allowances.length === 1 ? firstPatch : "x".repeat(10_000_000);
      return Effect.succeed(patch);
    };
    const layer = layerFor({
      projection: Effect.succeed(makeProjection()),
      authoredPaths: new Set(ownPaths),
      diffCheckpoints,
    });
    return Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const result = yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 });
      assert.isAtMost(Buffer.byteLength(result.diff), 10_000_000);
      assert.isTrue(result.diff.endsWith("\n\n[truncated]"));
      assert.deepEqual(
        allowances,
        Buffer.byteLength(firstPatch) >= 9_999_987 ? [9_999_988] : [9_999_988, 3_999_988],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("caps unfiltered diffs without splitting a UTF-8 character", () => {
  const layer = layerFor({
    projection: Effect.succeed(makeProjection()),
    diffCheckpoints: () => Effect.succeed("😀".repeat(2_500_000)),
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.isAtMost(Buffer.byteLength(result.diff), 10_000_000);
    assert.isTrue(result.diff.endsWith("\n\n[truncated]"));
    assert.notInclude(result.diff, "�");
  }).pipe(Effect.provide(layer));
});

it.effect.each([9_999_984, 9_999_985])(
  "drops a UTF-8 character cut by storage at byte %i",
  (prefixBytes) => {
    const layer = layerFor({
      projection: Effect.succeed(makeProjection()),
      diffCheckpoints: (input) =>
        Effect.succeed(
          Buffer.from(`${"x".repeat(prefixBytes)}😀`)
            .subarray(0, input.maxOutputBytes)
            .toString("utf8"),
        ),
    });
    return Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
      assert.isAtMost(Buffer.byteLength(result.diff), 10_000_000);
      assert.isTrue(result.diff.endsWith("\n\n[truncated]"));
      assert.notInclude(result.diff, "�");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("does not mark an exact-fit complete patch as truncated", () => {
  const layer = layerFor({
    projection: Effect.succeed(makeProjection()),
    diffCheckpoints: () => Effect.succeed("x".repeat(9_999_987)),
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.strictEqual(Buffer.byteLength(result.diff), 9_999_987);
    assert.notInclude(result.diff, "[truncated]");
  }).pipe(Effect.provide(layer));
});

it.effect("stops before the next batch when a patch exactly exhausts the budget", () => {
  const ownPaths = Array.from({ length: 1_000 }, (_, index) => `src/module-${index}/file.ts`);
  let patchReads = 0;
  const layer = layerFor({
    projection: Effect.succeed(makeProjection()),
    authoredPaths: new Set(ownPaths),
    diffCheckpoints: (input) => {
      if (input.format === "numstat") {
        return Effect.succeed(
          [...ownPaths, "upstream.ts"].map((path) => `1\t0\t${path}\0`).join(""),
        );
      }
      patchReads += 1;
      return Effect.succeed("x".repeat(9_999_987));
    },
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.strictEqual(Buffer.byteLength(result.diff), 10_000_000);
    assert.isTrue(result.diff.endsWith("\n\n[truncated]"));
    assert.strictEqual(patchReads, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-thread error contract", () => {
  const layer = layerFor({
    projection: Effect.fail(new OrchestratorProjectionError({ threadId })),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointThreadNotFoundError);
    assert.deepEqual(
      { operation: error.operation, threadId: error.threadId },
      { operation: "CheckpointDiffQuery.getTurnDiff", threadId },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed unavailable-range error contract", () => {
  const layer = layerFor({ projection: Effect.succeed(makeProjection()) });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 3 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 3, availableTurnCount: 2 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("excludes ready checkpoints from rolled-back runs", () => {
  const projection = makeProjection();
  const layer = layerFor({
    projection: Effect.succeed({
      ...projection,
      runs: projection.runs.map((run) =>
        run.id === secondRunId ? { ...run, status: "rolled_back" as const } : run,
      ),
      checkpoints: [
        {
          ...projection.checkpoints[0]!,
          scopeId: firstScopeId,
          runId: firstRunId,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/t3/test/first"),
        },
        ...projection.checkpoints,
      ],
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 2, availableTurnCount: 1 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-baseline-ref error contract", () => {
  const projection = makeProjection();
  const layer = layerFor({
    projection: Effect.succeed({
      ...projection,
      checkpointScopes: projection.checkpointScopes.map((scope) => ({
        ...scope,
        kind: "tool" as const,
      })),
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointRefUnavailableError);
    assert.deepEqual(
      { checkpoint: error.checkpoint, turnCount: error.turnCount },
      { checkpoint: "from", turnCount: 0 },
    );
  }).pipe(Effect.provide(layer));
});
