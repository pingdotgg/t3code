import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/**
 * Per-resource in-memory artifacts shared across a single `Plan.make -> apply`
 * execution.
 *
 * The engine scopes this service by resource `FQN` before invoking lifecycle
 * handlers, so providers should treat it as a resource-local bag for expensive,
 * deterministic intermediate results that can be reused across phases.
 *
 * Expected usage:
 *
 * - `diff` computes an expensive artifact once and stores it
 * - `create` / `update` reads the same artifact and skips recomputing it
 * - artifacts are ephemeral and must never be required for correctness on a
 *   later deploy because the bag is reset between runs
 *
 * Example:
 *
 * ```ts
 * const artifacts = yield* Artifacts;
 * const cached = yield* artifacts.get<PreparedBundle>("bundle");
 * if (cached) return cached;
 *
 * const bundle = yield* prepareBundle();
 * yield* artifacts.set("bundle", bundle);
 * return bundle;
 * ```
 */
export class Artifacts extends Context.Service<
  Artifacts,
  {
    /**
     * Get an artifact by key from the current resource's bag.
     */
    get<T>(key: string): Effect.Effect<T | undefined>;
    /**
     * Store an artifact by key in the current resource's bag.
     */
    set<T>(key: string, value: T): Effect.Effect<void>;
    /**
     * Delete an artifact by key from the current resource's bag.
     */
    delete(key: string): Effect.Effect<void>;
  }
>()("Artifacts") {}

type ArtifactBag = Map<string, unknown>;

export class ArtifactStore extends Context.Service<
  ArtifactStore,
  Map<string, ArtifactBag>
>()("Artifacts/Store") {}

/**
 * Create a fresh root store for one deploy/test run.
 */
export const createArtifactStore = (): ArtifactStore["Service"] =>
  new Map<string, ArtifactBag>();

const getOrCreateBag = (
  store: Map<string, ArtifactBag>,
  fqn: string,
): ArtifactBag => {
  const existing = store.get(fqn);
  if (existing) {
    return existing;
  }
  const bag = new Map<string, unknown>();
  store.set(fqn, bag);
  return bag;
};

export const makeScopedArtifacts = (
  store: Map<string, ArtifactBag>,
  fqn: string,
): Artifacts["Service"] => {
  const bag = getOrCreateBag(store, fqn);
  return {
    get: <T>(key: string) => Effect.sync(() => bag.get(key) as T | undefined),
    set: <T>(key: string, value: T) =>
      Effect.sync(() => {
        bag.set(key, value);
      }),
    delete: (key: string) =>
      Effect.sync(() => {
        bag.delete(key);
      }),
  };
};

export const scopedArtifacts = (
  fqn: string,
): Layer.Layer<Artifacts, never, ArtifactStore> =>
  Layer.effect(
    Artifacts,
    ArtifactStore.useSync((store) => makeScopedArtifacts(store, fqn)),
  );

/**
 * Run an effect with a fresh artifact root, replacing any existing store.
 * Use this at top-level entrypoints that intentionally define a new deploy run.
 */
export const provideFreshArtifactStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | ArtifactStore>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.provideServiceEffect(
      ArtifactStore,
      Effect.sync(createArtifactStore),
    ),
  );

/**
 * Ensure an artifact root exists, reusing the ambient store when one is already
 * present. This lets nested helpers participate in the same run-scoped cache.
 */
export const ensureArtifactStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | ArtifactStore>,
): Effect.Effect<A, E, R> =>
  Effect.serviceOption(ArtifactStore).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.flatMap((existing) =>
      effect.pipe(
        Effect.provideService(ArtifactStore, existing ?? createArtifactStore()),
      ),
    ),
  );

export const cached =
  (id: string) =>
  <A, Err = never, Req = never>(
    eff: Effect.Effect<A, Err, Req>,
  ): Effect.Effect<A, Err, Req | Artifacts> =>
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const deferred = yield* Deferred.make<A>();
      const cached = yield* artifacts.get<A>(id);
      if (cached) {
        if (Effect.isEffect(cached)) {
          return yield* cached;
        }
        return cached;
      }
      yield* artifacts.set(id, Deferred.await(deferred));
      const result = yield* eff;
      yield* Deferred.succeed(deferred, result);
      yield* artifacts.set(id, result);
      return result;
    });
