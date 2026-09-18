/**
 * `Hasher` over dynamically loaded Workers (DESIGN §22.12). A
 * `WorkerLoader` binding on the Git Worker instantiates the hasher module
 * (`WorkerLoaderModule.ts`, bundled into a string at build time by the `?worker`
 * import) under a few fixed names; each name is its own isolate with its
 * own 128 MB, and — measured — distinct isolates run in parallel with
 * the caller, up to the runtime's four concurrent dynamic invocations per
 * request. No cross-cloud hop, no credentials, no network for the hasher.
 *
 * Chunks are 4 MiB and the pump writes the spill parts (`writesSpill:
 * false`); any failure in the loaded worker hashes that chunk inline.
 *
 * **Example:** A Git host hashing pushes on dynamic Workers
 * ```typescript
 * import * as GitHasher from "alchemy/Git/Hasher";
 *
 * const GitLive = Git.ApiLive.pipe(
 *   Layer.provide(Git.ApiHandlersLive),
 *   Layer.provide(Authentication.layer),
 *   Layer.provide(Git.ReposDurableObject),
 *   Layer.provide(Git.RegistryDurableObject),
 *   Layer.provide(GitHasher.HasherWorkerLoader()),
 *   Layer.provide(Git.BlobStoreR2(GitObjects)),
 * );
 * ```
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { WorkerLoader } from "../../Cloudflare/Workers/WorkerLoader.ts";
import type {
  Worker,
  WorkerEnvironment,
} from "../../Cloudflare/Workers/Worker.ts";
import {
  hashBounds,
  resolveDeltas,
  scanPart,
} from "../Protocol/PartialScan.ts";
import { Hasher, type HasherShape } from "./Hasher.ts";
import {
  decodeDeltaResults,
  decodeScanResult,
  encodeDeltaBatch,
  HASH_ROUTE,
  HashError,
} from "./Protocol.ts";
import hasherSource from "./WorkerLoaderModule.ts?worker";

/** The runtime allows four concurrent dynamic-worker invocations per request. */
export const LOADER_MAX_CONCURRENCY = 4;
/** Chunk size: four in flight × 4 MiB keeps the working set small. */
export const LOADER_CHUNK_BYTES = 4 * 1024 * 1024;

export interface HasherWorkerLoaderOptions {
  /** The `worker_loader` binding name on the Git Worker. @default "GIT_HASHER_LOADER" */
  readonly binding?: string | undefined;
  /** Isolates (and concurrent chunks) per push, at most four. @default 4 */
  readonly concurrency?: number | undefined;
  /** Compatibility date of the loaded hasher. @default "2026-03-17" */
  readonly compatibilityDate?: string | undefined;
}

export const HasherWorkerLoader = (
  options: HasherWorkerLoaderOptions = {},
): Layer.Layer<Hasher, never, Worker | WorkerEnvironment> =>
  Layer.effect(
    Hasher,
    Effect.gen(function* () {
      const loader = yield* WorkerLoader(
        options.binding ?? "GIT_HASHER_LOADER",
      );
      const concurrency = Math.max(
        1,
        Math.min(
          options.concurrency ?? LOADER_MAX_CONCURRENCY,
          LOADER_MAX_CONCURRENCY,
        ),
      );
      // Fixed names: the runtime caches an isolate per name, so a slot is
      // warm across pushes; distinct names are what makes them parallel.
      const idle: Array<string> = Array.from(
        { length: concurrency },
        (_, i) => `git-hasher-${i}`,
      );
      const gate = yield* Semaphore.make(concurrency);
      const code = () => ({
        compatibilityDate: options.compatibilityDate ?? "2026-03-17",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "hasher.js",
        modules: { "hasher.js": hasherSource },
        globalOutbound: null,
      });
      /** One call on a free slot: POST `body` to `path` on the loaded hasher, answer bytes (sans frame). */
      const call = (path: string, body: Uint8Array) =>
        Semaphore.withPermits(
          gate,
          1,
        )(
          Effect.acquireUseRelease(
            Effect.sync(() => idle.pop()!),
            (slot) =>
              Effect.gen(function* () {
                const worker = yield* loader.get(slot, code);
                const response = yield* worker
                  .fetch(
                    HttpClientRequest.post(`https://hasher${path}`).pipe(
                      HttpClientRequest.bodyUint8Array(body),
                    ),
                  )
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new HashError({
                          reason: `dynamic hasher: ${String(error)}`,
                        }),
                    ),
                  );
                const bytes = new Uint8Array(
                  yield* response.arrayBuffer.pipe(
                    Effect.mapError(
                      (error) =>
                        new HashError({
                          reason: `dynamic hasher body: ${String(error)}`,
                        }),
                    ),
                  ),
                );
                if (response.status !== 200) {
                  return yield* new HashError({
                    reason: `dynamic hasher: status ${response.status}: ${new TextDecoder().decode(bytes.subarray(0, 200))}`,
                  });
                }
                // One frame: `u32 len | payload`.
                return bytes.subarray(4);
              }),
            (slot) => Effect.sync(() => void idle.push(slot)),
          ),
        );
      const remote = (
        payload: Uint8Array,
        opts: Parameters<HasherShape["hashPart"]>[1],
      ) =>
        call(
          `${HASH_ROUTE}?base=${opts.base}&remaining=${opts.remaining}&max=${opts.maxObjectSize}${opts.resync ? "&resync=1" : ""}${opts.skip ? `&skip=${opts.skip}` : ""}`,
          payload,
        ).pipe(Effect.map(decodeScanResult));
      return {
        writesSpill: false,
        chunkBytes: LOADER_CHUNK_BYTES,
        concurrency,
        hashPart: (payload, opts) =>
          remote(payload, opts).pipe(
            Effect.catchTag("HashError", (error) => {
              console.warn(`[hasher] ${error.reason}; hashing inline`);
              const skip = opts.skip ?? 0;
              return scanPart(
                skip > 0 ? payload.subarray(skip) : payload,
                opts,
              );
            }),
          ),
        resolveDeltas: (bases, jobs, opts) =>
          call(
            `${HASH_ROUTE}?mode=deltas&max=${opts.maxObjectSize}`,
            encodeDeltaBatch(bases, jobs),
          ).pipe(
            Effect.map(decodeDeltaResults),
            Effect.catchTag("HashError", (error) => {
              console.warn(`[hasher] ${error.reason}; resolving inline`);
              return resolveDeltas(bases, jobs, opts);
            }),
          ),
        hashBoundsPart: (payload, bounds, opts) =>
          hashBounds(payload, bounds, opts),
      } satisfies HasherShape;
    }),
  );
