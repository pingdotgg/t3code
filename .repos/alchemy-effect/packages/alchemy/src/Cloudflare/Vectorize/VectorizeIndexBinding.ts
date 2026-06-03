import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { VectorizeIndex } from "./VectorizeIndex.ts";

export interface VectorizeIndexClient {
  /**
   * An Effect that resolves to the raw underlying Cloudflare Vectorize
   * binding. Use this for direct access not covered by the helpers below.
   */
  raw: Effect.Effect<runtime.Vectorize>;
  /** Get information about the bound index (dimensions, vector count). */
  describe: () => Effect.Effect<runtime.VectorizeIndexInfo>;
  /** Find the nearest neighbors of `vector`. */
  query: (
    vector: runtime.VectorFloatArray | number[],
    options?: runtime.VectorizeQueryOptions,
  ) => Effect.Effect<runtime.VectorizeMatches>;
  /** Find the nearest neighbors of an existing vector by its id. */
  queryById: (
    vectorId: string,
    options?: runtime.VectorizeQueryOptions,
  ) => Effect.Effect<runtime.VectorizeMatches>;
  /** Insert vectors. Throws if any provided id already exists. */
  insert: (
    vectors: runtime.VectorizeVector[],
  ) => Effect.Effect<runtime.VectorizeAsyncMutation>;
  /** Upsert vectors, replacing any existing vectors with matching ids. */
  upsert: (
    vectors: runtime.VectorizeVector[],
  ) => Effect.Effect<runtime.VectorizeAsyncMutation>;
  /** Delete vectors by id. */
  deleteByIds: (ids: string[]) => Effect.Effect<runtime.VectorizeAsyncMutation>;
  /** Fetch vectors by id. */
  getByIds: (ids: string[]) => Effect.Effect<runtime.VectorizeVector[]>;
}

export class VectorizeIndexBinding extends Binding.Service<
  VectorizeIndexBinding,
  (index: VectorizeIndex) => Effect.Effect<VectorizeIndexClient>
>()("Cloudflare.Vectorize.IndexBinding") {}

export const VectorizeIndexBindingLive = Layer.effect(
  VectorizeIndexBinding,
  Effect.gen(function* () {
    const Policy = yield* VectorizeIndexBindingPolicy;

    return Effect.fn(function* (index: VectorizeIndex) {
      yield* Policy(index);
      const rawEff = yield* Effect.serviceOption(WorkerEnvironment).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.map((env) => env?.[index.LogicalId]! as runtime.Vectorize),
        Effect.cached,
      );

      const withRuntime = <A>(fn: (raw: runtime.Vectorize) => Promise<A>) =>
        Effect.flatMap(rawEff, (raw) => Effect.promise(() => fn(raw)));

      return {
        raw: rawEff,
        describe: () => withRuntime((raw) => raw.describe()),
        query: (vector, options) =>
          withRuntime((raw) => raw.query(vector, options)),
        queryById: (vectorId, options) =>
          withRuntime((raw) => raw.queryById(vectorId, options)),
        insert: (vectors) => withRuntime((raw) => raw.insert(vectors)),
        upsert: (vectors) => withRuntime((raw) => raw.upsert(vectors)),
        deleteByIds: (ids) => withRuntime((raw) => raw.deleteByIds(ids)),
        getByIds: (ids) => withRuntime((raw) => raw.getByIds(ids)),
      } satisfies VectorizeIndexClient;
    });
  }),
);

export class VectorizeIndexBindingPolicy extends Binding.Policy<
  VectorizeIndexBindingPolicy,
  (index: VectorizeIndex) => Effect.Effect<void>
>()("Cloudflare.Vectorize.IndexBinding") {}

export const VectorizeIndexBindingPolicyLive =
  VectorizeIndexBindingPolicy.layer.succeed(
    Effect.fn(function* (host: ResourceLike, index: VectorizeIndex) {
      if (isWorker(host)) {
        yield* host.bind`${index}`({
          bindings: [
            {
              type: "vectorize",
              name: index.LogicalId,
              indexName: index.indexName,
            },
          ],
        });
      } else {
        return yield* Effect.die(
          new Error(`IndexBinding does not support runtime '${host.Type}'`),
        );
      }
    }),
  );
