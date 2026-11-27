import { type CheckpointRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CheckpointStoreError } from "./Errors.ts";
import type {
  VcsCheckpointOps,
  VcsCheckpointRange,
  CheckpointCaptureResult,
} from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** The checkpoint this one follows, so a turn that switched branches starts where it landed. */
  readonly previousCheckpointRef?: CheckpointRef;
  /** Folders below `cwd` (relative, `/`-separated) that have their own checkpoints. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export type CheckpointRange = VcsCheckpointRange;

export interface CaptureHeadCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** A commit `resolveCleanHead` returned for this folder. */
  readonly head: string;
  /**
   * When the folder was seen clean, in epoch seconds, if that was earlier than now. Commits made
   * after a checkpoint count as the turn's own work, so a late snapshot must not postdate them.
   */
  readonly seenAt?: number;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
  /** Folders below `cwd` the restore leaves as they are, as in a capture. */
  readonly excludePaths?: ReadonlyArray<string>;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
  /** Folders below `cwd` left out of the diff, as in a capture. */
  readonly excludePaths?: ReadonlyArray<string>;
  /** The refs' range as their capture returned it; the refs are then not read. */
  readonly range?: VcsCheckpointRange;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  /** The refs' range as their capture returned it; the refs are then not read. */
  readonly range?: VcsCheckpointRange;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    /** Whether this workspace's VCS driver can capture and restore checkpoints here. */
    readonly supportsCheckpoints: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<CheckpointCaptureResult, CheckpointStoreError>;

    /**
     * HEAD's commit when the folder matches it exactly: nothing staged, modified or untracked.
     * Null otherwise. One status, where a capture stages the whole worktree.
     */
    readonly resolveCleanHead: (cwd: string) => Effect.Effect<string | null, CheckpointStoreError>;

    /** Snapshots a folder that was clean at `head` from that commit, without reading its files. */
    readonly captureHeadCheckpoint: (
      input: CaptureHeadCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly copyCheckpointRef: VcsCheckpointOps["copyCheckpointRef"];

    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /** Null means HEAD is unchanged or unrecorded; all changed paths then belong to the turn. */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  const supportsCheckpoints: CheckpointStore["Service"]["supportsCheckpoints"] = Effect.fn(
    "CheckpointStore.supportsCheckpoints",
  )(function* (cwd: string) {
    const handle = yield* vcsRegistry.detect({ cwd });
    if (handle === null) {
      // The registry treats an unreadable Git repository as absent; checkpoints need its failure.
      const git = yield* vcsRegistry.get("git");
      return (yield* git.detectRepository(cwd)) !== null;
    }
    if (!handle.driver.checkpoints) return false;
    const usable = handle.driver.checkpointsUsable;
    return usable ? yield* usable(cwd) : true;
  });

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.captureCheckpoint(input);
  });

  const resolveCleanHead: CheckpointStore["Service"]["resolveCleanHead"] = Effect.fn(
    "CheckpointStore.resolveCleanHead",
  )(function* (cwd) {
    const checkpoints = yield* resolveCheckpoints(cwd);
    return yield* checkpoints.resolveCleanHead(cwd);
  });

  const captureHeadCheckpoint: CheckpointStore["Service"]["captureHeadCheckpoint"] = Effect.fn(
    "CheckpointStore.captureHeadCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.captureHeadCheckpoint(input);
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.hasCheckpointRef(input);
  });

  const copyCheckpointRef: CheckpointStore["Service"]["copyCheckpointRef"] = Effect.fn(
    "CheckpointStore.copyCheckpointRef",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.copyCheckpointRef(input);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.restoreCheckpoint(input);
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.diffCheckpoints(input);
  });

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.listAuthoredPaths(input);
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(input.cwd);
    return yield* checkpoints.deleteCheckpointRefs(input);
  });

  return CheckpointStore.of({
    supportsCheckpoints,
    captureCheckpoint,
    resolveCleanHead,
    captureHeadCheckpoint,
    hasCheckpointRef,
    copyCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
