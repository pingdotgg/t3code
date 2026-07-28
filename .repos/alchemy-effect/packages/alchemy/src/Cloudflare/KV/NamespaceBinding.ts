import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Namespace } from "./Namespace.ts";
import { NamespaceError } from "./NamespaceTypes.ts";

/**
 * Shared scaffolding for the Worker-binding implementations of the KV
 * services.
 *
 * Resolves the {@link WorkerEnvironment} and host {@link Worker}, registers
 * the `kv_namespace` binding at deploy time, then delegates to `makeClient`
 * with the shared {@link makeKVNamespaceHelpers} to build the
 * read/write/read-write client.
 */
export const makeKVNamespaceBinding = <Client>(options: {
  makeClient: (helpers: ReturnType<typeof makeKVNamespaceHelpers>) => Client;
}) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (namespace: Namespace) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${namespace}`({
          bindings: [
            {
              type: "kv_namespace",
              name: namespace.LogicalId,
              namespaceId: namespace.namespaceId,
            },
          ],
        });
      }

      return options.makeClient(makeKVNamespaceHelpers(env, namespace));
    });
  });

/** Primitives shared by the read and write halves of the binding client. */
export const makeKVNamespaceHelpers = (
  env: Record<string, any>,
  namespace: Namespace,
) => {
  const raw = Effect.sync(
    // Lazy — the WorkerEnvironment binding is not populated until runtime.
    () => (env as Record<string, runtime.KVNamespace>)[namespace.LogicalId]!,
  );

  const tryPromise = <T>(
    fn: () => Promise<T>,
  ): Effect.Effect<T, NamespaceError> =>
    Effect.tryPromise({
      try: fn,
      catch: (error: any) =>
        new NamespaceError({
          message: error?.message ?? "Unknown error",
          cause: error,
        }),
    });

  const use = <T>(
    fn: (raw: runtime.KVNamespace<string>) => Promise<T>,
  ): Effect.Effect<T, NamespaceError> =>
    raw.pipe(Effect.flatMap((raw) => tryPromise(() => fn(raw))));

  return { raw, use, tryPromise };
};
