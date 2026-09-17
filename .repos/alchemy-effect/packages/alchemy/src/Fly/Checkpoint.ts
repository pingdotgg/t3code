import type {
  Checkpoint as FlyCheckpoint,
  CreateCheckpointError,
  GetCheckpointError,
  ListCheckpointsError,
  RestoreCheckpointError,
  StreamEvent,
} from "@distilled.cloud/fly-io/sprites";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Sprite } from "./Sprite.ts";

export interface CheckpointClient {
  /**
   * Create a checkpoint of the Sprite filesystem. Returns NDJSON
   * progress events. The checkpoint id is in a `complete` event.
   */
  create: (options?: {
    comment?: string;
  }) => Effect.Effect<
    ReadonlyArray<StreamEvent>,
    CreateCheckpointError,
    RuntimeContext
  >;
  /** List checkpoints on the Sprite. */
  list: () => Effect.Effect<
    ReadonlyArray<FlyCheckpoint>,
    ListCheckpointsError,
    RuntimeContext
  >;
  /** Get one checkpoint by id (`v1`, `v2`, …). */
  get: (
    checkpointId: string,
  ) => Effect.Effect<FlyCheckpoint, GetCheckpointError, RuntimeContext>;
  /**
   * Restore the Sprite filesystem to a checkpoint. Destructive.
   * Returns NDJSON progress events.
   */
  restore: (
    checkpointId: string,
  ) => Effect.Effect<
    ReadonlyArray<StreamEvent>,
    RestoreCheckpointError,
    RuntimeContext
  >;
}

/**
 * Checkpoint and restore a {@link Sprite} filesystem.
 *
 *
 * ### Create a checkpoint
 * Bind the client in init. Provide {@link CheckpointHttp}.
 *
 * **Example:** Create
 * ```typescript
 * const checkpoint = yield* Fly.Checkpoint(Box);
 * yield* checkpoint.create({ comment: "before deploy" });
 * ```
 *
 * ### Restore
 * Restore rewinds the filesystem. Running processes stop.
 *
 * **Example:** Restore v1
 * ```typescript
 * yield* checkpoint.restore("v1");
 * ```
 *
 * :::caution[Restore is destructive]
 * The Sprite disk goes back to that checkpoint. Later writes are gone.
 * :::
 *
 * @binding
 */
export interface Checkpoint extends Binding.Service<
  Checkpoint,
  "Fly.Checkpoint",
  (sprite: Sprite) => Effect.Effect<CheckpointClient>
> {}

export const Checkpoint = Binding.Service<Checkpoint>("Fly.Checkpoint");
