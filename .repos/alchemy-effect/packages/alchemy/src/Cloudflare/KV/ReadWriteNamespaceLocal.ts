import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLocalKVNamespaceBinding } from "./NamespaceLocal.ts";
import { ReadWriteNamespace } from "./ReadWriteNamespace.ts";
import { makeReadWriteKVHttpClient } from "./ReadWriteNamespaceHttp.ts";

/**
 * Local implementation of the {@link ReadWriteNamespace} binding — reads and
 * writes KV values over the Cloudflare HTTP API using the **current
 * credentials** instead of a native Worker binding
 * (`ReadWriteNamespaceBinding`) or a scoped API token
 * (`ReadWriteNamespaceHttp`).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can talk
 * to a namespace with the same `get`/`put`/`list`/`delete` client you'd use
 * inside a Worker:
 *
 * @example Seeding a namespace from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const kv = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
 *     return Effect.fn(function* () {
 *       yield* kv.put("greeting", "hello world");
 *       return yield* kv.get("greeting");
 *     });
 *   }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceLocal)),
 * );
 * ```
 *
 * The namespace id is resolved at apply time through the ambient
 * {@link RuntimeContext} (in an Action, that's the resolve context the engine
 * provides around the body), so `ReadWriteNamespace(namespace)` works even
 * though the namespace is created in the same deploy.
 */
export const ReadWriteNamespaceLocal = Layer.effect(
  ReadWriteNamespace,
  Effect.suspend(() =>
    makeLocalKVNamespaceBinding({ makeClient: makeReadWriteKVHttpClient }),
  ),
);
