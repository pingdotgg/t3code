import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import * as Binding from "./Binding.ts";
import type { VersionMetadataBinding } from "./VersionMetadataBinding.ts";

const TypeId = "Cloudflare.Workers.VersionMetadata" as const;
type TypeId = typeof TypeId;

/**
 * Runtime value Cloudflare exposes for a `version_metadata` binding — the
 * deployed Worker version's `id`, `tag`, and `timestamp`.
 */
export interface WorkerVersionMetadata {
  readonly id: string;
  readonly tag: string;
  readonly timestamp: string;
}

/**
 * Effect-native accessor for the version metadata. The env binding only exists
 * at the *exec* phase on the deployed Worker, so reading it is deferred behind
 * an Effect that requires {@link RuntimeContext}. Yield it inside a handler to
 * obtain the {@link WorkerVersionMetadata}.
 */
export type VersionMetadataAccessor = Effect.Effect<
  WorkerVersionMetadata,
  never,
  RuntimeContext
>;

/**
 * A Cloudflare Workers Version Metadata binding — a Worker-only binding with no
 * backing cloud resource. Cloudflare provides the deployed Worker version at
 * runtime (`id`, `tag`, `timestamp`).
 *
 * `VersionMetadata` is a single value that is at once the `Binding.Service` tag,
 * the callable that produces a {@link VersionMetadataBinding}, and the type.
 * Declare it on a Worker's `env` (it flows through `InferEnv` →
 * {@link WorkerVersionMetadata}) or `yield*` it inside an Effect-native Worker
 * to attach the binding and obtain a deferred {@link VersionMetadataAccessor}.
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 * @section Effect-style Worker (recommended)
 * @example Read the deployed version from inside a handler
 * ```typescript
 * import * as Effect from "effect/Effect";
 *
 * Cloudflare.Worker(
 *   "VersionWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Attaches the binding to this Worker AND returns a deferred accessor.
 *     const versionMetadata = yield* Cloudflare.Workers.VersionMetadata();
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { id, tag, timestamp } = yield* versionMetadata;
 *         return Response.json({ id, tag, timestamp });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.VersionMetadataBinding)),
 * );
 * ```
 *
 * @section Worker binding metadata
 * @example
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: { CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata() },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { CF_VERSION_METADATA: WorkerVersionMetadata }
 * ```
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/
 */
export interface VersionMetadata extends Binding.Service<
  VersionMetadata,
  TypeId,
  VersionMetadataAccessor
> {
  /**
   * @param name Binding name (logical id) — the `env` key it resolves to.
   * @default "CF_VERSION_METADATA"
   */
  (name?: string): VersionMetadataBinding;
}

export const VersionMetadata = Binding.Service<VersionMetadata>({
  id: TypeId,
  defaultName: "CF_VERSION_METADATA",
  toWorkerBinding: (binding) => ({
    type: "version_metadata",
    name: binding.name,
  }),
});

export const isVersionMetadata = (
  value: unknown,
): value is VersionMetadataBinding =>
  Binding.isBinding(value) && value.kind === TypeId;
