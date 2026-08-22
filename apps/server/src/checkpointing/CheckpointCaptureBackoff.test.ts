import { it } from "@effect/vitest";
import { ThreadId, VcsProcessTimeoutError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import * as CheckpointStore from "./CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";

const CWD = "/repo/huge-monorepo";
const THREAD_ID = ThreadId.make("thread-checkpoint-backoff");

const captureTimeout = new VcsProcessTimeoutError({
  operation: "GitVcsDriver.checkpoints.captureCheckpoint",
  command: "git add",
  cwd: CWD,
  timeoutMs: 30_000,
});

/**
 * A driver whose capture always exceeds the process timeout, matching a
 * repository too large for a full-tree `git add -A` to finish in time.
 */
function makeAlwaysTimingOutRegistry(
  captureAttempts: { count: number },
  options: { readonly succeedOnAttempt?: number } = {},
) {
  const checkpoints = {
    captureCheckpoint: () =>
      Effect.suspend(() => {
        captureAttempts.count += 1;
        return captureAttempts.count === options.succeedOnAttempt
          ? Effect.void
          : Effect.fail(captureTimeout);
      }),
    hasCheckpointRef: () => Effect.succeed(false),
    restoreCheckpoint: () => Effect.succeed(false),
    diffCheckpoints: () => Effect.succeed(""),
    deleteCheckpointRefs: () => Effect.void,
  } as unknown as VcsDriver.VcsCheckpointOps;

  const handle = {
    kind: "git" as const,
    repository: {
      kind: "git" as const,
      rootPath: CWD,
      metadataPath: `${CWD}/.git`,
      freshness: { source: "cache" as const, checkedAt: 0 },
    },
    driver: { checkpoints } as unknown as VcsDriver.VcsDriver["Service"],
  } as unknown as VcsDriverRegistry.VcsDriverHandle;

  return Layer.succeed(
    VcsDriverRegistry.VcsDriverRegistry,
    VcsDriverRegistry.VcsDriverRegistry.of({
      get: () => Effect.succeed(handle.driver),
      detect: () => Effect.succeed(handle),
      resolve: () => Effect.succeed(handle),
    }),
  );
}

describe("checkpoint capture backoff", () => {
  it.effect("stops re-running a capture that keeps timing out", () => {
    const captureAttempts = { count: 0 };

    return Effect.gen(function* () {
      const store = yield* CheckpointStore.CheckpointStore;
      const capture = (turn: number) =>
        store
          .captureCheckpoint({
            cwd: CWD,
            checkpointRef: checkpointRefForThreadTurn(THREAD_ID, turn),
          })
          .pipe(Effect.flip);

      // The first three turns each pay for a real capture attempt.
      for (let turn = 1; turn <= 3; turn += 1) {
        const error = yield* capture(turn);
        expect(error._tag).toBe("VcsProcessTimeoutError");
      }
      expect(captureAttempts.count).toBe(3);

      // Every later turn inside the cooldown replays the recorded failure
      // without spawning git again. The cooldown is minutes long, so the rest
      // of this test runs well inside it.
      for (let turn = 4; turn <= 20; turn += 1) {
        const error = yield* capture(turn);
        expect(error).toBe(captureTimeout);
      }
      expect(captureAttempts.count).toBe(3);
    }).pipe(
      Effect.provide(
        CheckpointStore.layer.pipe(Layer.provide(makeAlwaysTimingOutRegistry(captureAttempts))),
      ),
    );
  });

  it.effect("does not hold a workspace when the driver cannot be resolved", () => {
    const captureAttempts = { count: 0 };
    const registryFailure = new VcsProcessTimeoutError({
      operation: "VcsDriverRegistry.resolve",
      command: "git rev-parse",
      cwd: CWD,
      timeoutMs: 5_000,
    });
    const failingRegistry = Layer.succeed(
      VcsDriverRegistry.VcsDriverRegistry,
      VcsDriverRegistry.VcsDriverRegistry.of({
        get: () => Effect.fail(registryFailure),
        detect: () => Effect.fail(registryFailure),
        resolve: () => Effect.fail(registryFailure),
      }) as never,
    );

    return Effect.gen(function* () {
      const store = yield* CheckpointStore.CheckpointStore;
      const capture = (turn: number) =>
        store
          .captureCheckpoint({
            cwd: CWD,
            checkpointRef: checkpointRefForThreadTurn(THREAD_ID, turn),
          })
          .pipe(Effect.flip);

      // Failing before the driver runs still counts as a failure, so the
      // first two turns stay under the threshold and keep retrying rather
      // than being held by a stale reservation.
      for (let turn = 1; turn <= 2; turn += 1) {
        const error = yield* capture(turn);
        expect(error).toBe(registryFailure);
      }
      expect(captureAttempts.count).toBe(0);
    }).pipe(Effect.provide(CheckpointStore.layer.pipe(Layer.provide(failingRegistry))));
  });

  it.effect("keeps capturing for a workspace that recovers", () => {
    const captureAttempts = { count: 0 };

    return Effect.gen(function* () {
      const store = yield* CheckpointStore.CheckpointStore;
      const capture = (turn: number) =>
        store.captureCheckpoint({
          cwd: CWD,
          checkpointRef: checkpointRefForThreadTurn(THREAD_ID, turn),
        });

      // Two failures stay under the threshold, and the success that follows
      // clears them, so a later isolated failure does not open a cooldown.
      yield* capture(1).pipe(Effect.flip);
      yield* capture(2).pipe(Effect.flip);
      yield* capture(3);
      yield* capture(4).pipe(Effect.flip);
      yield* capture(5).pipe(Effect.flip);
      yield* capture(6).pipe(Effect.flip);

      expect(captureAttempts.count).toBe(6);
    }).pipe(
      Effect.provide(
        CheckpointStore.layer.pipe(
          Layer.provide(makeAlwaysTimingOutRegistry(captureAttempts, { succeedOnAttempt: 3 })),
        ),
      ),
    );
  });
});
