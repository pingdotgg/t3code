import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  BackingPersistence,
  PersistenceError,
  type BackingPersistenceStore,
} from "effect/unstable/persistence/Persistence";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { DurableObjectState } from "./DurableObjectState.ts";

/**
 * A `BackingPersistence` layer (Effect AI persistence module) backed
 * by the surrounding Durable Object's `state.storage`. Drop-in storage
 * for `Persistence.layerResultPersisted({ storeId })` so chat history,
 * cached AI responses, or any other persisted state lives in the DO
 * SQLite store with `${storeId}:` key namespacing.
 *
 * Multiple `storeId`s can coexist within a single Durable Object —
 * keys are namespaced with a `${storeId}:` prefix so they don't
 * collide.
 *
 * :::caution
 * TTL is currently ignored; Durable Object storage has no native TTL.
 * If you need expiry, layer a TTL-aware backing store on top, or run
 * a periodic `clear`.
 * :::
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 *
 * @section Wiring it into a chat-backing DO
 * @example Persisted chat history per DO instance
 * `Persistence.layerResultPersisted({ storeId })` is the seam Effect
 * AI exposes for cached/replayable AI calls. Layer
 * `DurableObjectChatPersistence` underneath and every entry is stored
 * in the DO's `state.storage` under the `alchemy.chat:` prefix.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Chat, LanguageModel } from "effect/unstable/ai";
 * import { Persistence } from "effect/unstable/persistence";
 *
 * export default class ChatBackend extends Cloudflare.DurableObject<ChatBackend>()(
 *   "ChatBackend",
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const persistence = yield* Persistence.layerResultPersisted({
 *         storeId: "alchemy.chat",
 *       }).pipe(Layer.provide(Cloudflare.AI.DurableObjectChatPersistence));
 *
 *       return {
 *         send: (threadId: string, prompt: string) =>
 *           LanguageModel.generateText({ prompt }).pipe(Effect.provide(persistence)),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @section Multiple stores in the same DO
 * @example Separate `storeId`s coexist
 * Different `storeId`s namespace their keys with `${storeId}:`, so
 * one DO can keep, say, chat history *and* an audit log in separate
 * stores without colliding.
 * ```typescript
 * const aiPersistence = yield* Persistence.layerResultPersisted({
 *   storeId: "alchemy.chat",
 * }).pipe(Layer.provide(Cloudflare.AI.DurableObjectChatPersistence));
 *
 * const auditPersistence = yield* Persistence.layerResultPersisted({
 *   storeId: "alchemy.audit",
 * }).pipe(Layer.provide(Cloudflare.AI.DurableObjectChatPersistence));
 * ```
 */
export const DurableObjectChatPersistence = Layer.effect(BackingPersistence)(
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const storage = state.storage;

    const wrapErr = (op: string, key?: string) => (cause: unknown) =>
      new PersistenceError({
        message: `Failed to ${op}${key !== undefined ? ` key ${key}` : ""} in DurableObject storage`,
        cause,
      });

    return BackingPersistence.of({
      make: (storeId) =>
        Effect.sync(() => {
          const prefixed = (k: string) => `${storeId}:${k}`;
          return {
            get: (key) =>
              storage
                .get<object>(prefixed(key))
                .pipe(
                  Effect.mapError(wrapErr("get", key)),
                  Effect.provide(RuntimeContext.phantom),
                ),
            getMany: (keys) =>
              storage.get<object>(keys.map(prefixed)).pipe(
                Effect.mapError(wrapErr("getMany")),
                Effect.map(
                  (map) =>
                    keys.map((k) => map.get(prefixed(k))) as Arr.NonEmptyArray<
                      object | undefined
                    >,
                ),
                Effect.provide(RuntimeContext.phantom),
              ),
            set: (key, value, _ttl) =>
              storage
                .put(prefixed(key), value)
                .pipe(
                  Effect.mapError(wrapErr("set", key)),
                  Effect.provide(RuntimeContext.phantom),
                ),
            setMany: (entries) =>
              storage
                .put(
                  Object.fromEntries(entries.map(([k, v]) => [prefixed(k), v])),
                )
                .pipe(
                  Effect.mapError(wrapErr("setMany")),
                  Effect.provide(RuntimeContext.phantom),
                ),
            remove: (key) =>
              storage
                .delete(prefixed(key))
                .pipe(
                  Effect.asVoid,
                  Effect.mapError(wrapErr("remove", key)),
                  Effect.provide(RuntimeContext.phantom),
                ),
            clear: storage.list({ prefix: `${storeId}:` }).pipe(
              Effect.flatMap((map) => {
                const ks = [...map.keys()];
                if (ks.length === 0) return Effect.void;
                return Effect.asVoid(storage.delete(ks));
              }),
              Effect.mapError(wrapErr("clear")),
              Effect.provide(RuntimeContext.phantom),
            ),
          } satisfies BackingPersistenceStore;
        }),
    });
  }),
);
