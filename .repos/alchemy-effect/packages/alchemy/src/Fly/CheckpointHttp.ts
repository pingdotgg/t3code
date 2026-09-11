import { CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as sprites from "@distilled.cloud/fly-io/sprites";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Checkpoint, type CheckpointClient } from "./Checkpoint.ts";
import { makeHttpSpriteBinding } from "./SpriteHttp.ts";

/**
 * HTTP implementation of {@link Checkpoint}. Provide it on the
 * {@link Sprite}, {@link Service}, or Action Effect.
 *
 *
 * ### Provide the layer
 * **Example:** On a Sprite
 * ```typescript
 * Effect.gen(function* () {
 *   const checkpoint = yield* Fly.Checkpoint(Box);
 *   // ...
 * }).pipe(Effect.provide(Fly.CheckpointHttp))
 * ```
 *
 * @layer
 * @provides Fly.Checkpoint
 */
export const CheckpointHttp = Layer.effect(
  Checkpoint,
  Effect.suspend(() =>
    makeHttpSpriteBinding({
      makeClient: (auth, spriteName): CheckpointClient => ({
        create: Effect.fn("Fly.Checkpoint.create")(function* (options) {
          return yield* auth.authorize(
            sprites.createCheckpoint({
              name: yield* spriteName,
              comment: options?.comment,
            }),
          );
        }),
        list: Effect.fn("Fly.Checkpoint.list")(function* () {
          return yield* auth.authorize(
            sprites.listCheckpoints({
              name: yield* spriteName,
            }),
          );
        }),
        get: Effect.fn("Fly.Checkpoint.get")(function* (checkpointId) {
          return yield* auth.authorize(
            sprites.getCheckpoint({
              name: yield* spriteName,
              checkpoint_id: checkpointId,
            }),
          );
        }),
        restore: Effect.fn("Fly.Checkpoint.restore")(function* (checkpointId) {
          return yield* auth.authorize(
            sprites.restoreCheckpoint({
              name: yield* spriteName,
              checkpoint_id: checkpointId,
            }),
          );
        }),
      }),
    }),
  ),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(CredentialsFromEnv));
