import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLocalKVNamespaceBinding } from "./NamespaceLocal.ts";
import { ReadNamespace } from "./ReadNamespace.ts";
import { makeReadKVHttpClient } from "./ReadNamespaceHttp.ts";

/**
 * Local implementation of the {@link ReadNamespace} binding — reads KV values
 * over the Cloudflare HTTP API using the **current credentials** instead of a
 * native Worker binding (`ReadNamespaceBinding`) or a scoped API token
 * (`ReadNamespaceHttp`).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can read
 * from a namespace with the same `get`/`getWithMetadata`/`list` client you'd
 * use inside a Worker:
 *
 * @example Reading a value from an Action
 * ```typescript
 * const Check = Alchemy.Action(
 *   "Check",
 *   Effect.gen(function* () {
 *     const kv = yield* Cloudflare.KV.ReadNamespace(namespace);
 *     return Effect.fn(function* () {
 *       return yield* kv.get("my-key");
 *     });
 *   }).pipe(Effect.provide(Cloudflare.KV.ReadNamespaceLocal)),
 * );
 * ```
 */
export const ReadNamespaceLocal = Layer.effect(
  ReadNamespace,
  Effect.suspend(() =>
    makeLocalKVNamespaceBinding({ makeClient: makeReadKVHttpClient }),
  ),
);
