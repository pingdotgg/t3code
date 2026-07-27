import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLocalKVNamespaceBinding } from "./NamespaceLocal.ts";
import { WriteNamespace } from "./WriteNamespace.ts";
import { makeWriteKVHttpClient } from "./WriteNamespaceHttp.ts";

/**
 * Local implementation of the {@link WriteNamespace} binding — writes KV
 * values over the Cloudflare HTTP API using the **current credentials**
 * instead of a native Worker binding (`WriteNamespaceBinding`) or a scoped API
 * token (`WriteNamespaceHttp`).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can write
 * to a namespace with the same `put`/`delete` client you'd use inside a
 * Worker:
 *
 * @example Writing a value from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const kv = yield* Cloudflare.KV.WriteNamespace(namespace);
 *     return Effect.fn(function* () {
 *       yield* kv.put("my-key", "hello world");
 *     });
 *   }).pipe(Effect.provide(Cloudflare.KV.WriteNamespaceLocal)),
 * );
 * ```
 */
export const WriteNamespaceLocal = Layer.effect(
  WriteNamespace,
  Effect.suspend(() =>
    makeLocalKVNamespaceBinding({ makeClient: makeWriteKVHttpClient }),
  ),
);
