/**
 * The pack hasher (DESIGN §22.7): the CPU-heavy half of push ingest —
 * inflating and hashing entries, applying in-buffer deltas — as a service
 * the receive-pack pipeline calls per spilled part, so the repo's Durable
 * Object only receives bytes and stages rows.
 *
 * Two layers:
 *
 * - {@link HasherInline} runs the scan in the calling isolate — the
 *   reference assembly. On Cloudflare Workers a service-binding subrequest
 *   executes on the caller's own thread (measured, DESIGN §22.10), so
 *   fanning out buys no CPU there; inline avoids the copies and framing.
 * - {@link HasherSelf} posts each part to the Worker's own
 *   `/_alchemy/git/hash` route through a `Cloudflare.Workers.Self` service
 *   binding: the same work in another invocation of the same script. Kept
 *   for runtimes where such calls do run in parallel, and as the shape a
 *   remote hasher (a Container running native `index-pack`, a multi-core
 *   host behind a cross-zone URL) would take.
 *
 * The wire protocol is binary both ways (parts are megabytes; JSON would
 * base64 them): request body = the raw bytes, coordinates in the query;
 * response = `u32 jsonLength | json | blob area`, where the JSON's entries
 * reference their content/zdata as `[offset, length]` into the blob area.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import { WorkerEnvironment } from "../../Cloudflare/Workers/Worker.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { Random } from "../../Random.ts";
import {
  BlobStore,
  type BlobStoreShape,
  type UploadedPart,
} from "../BlobStore.ts";
import type { Oid, ObjectType } from "../Protocol/ObjectCodec.ts";
import {
  type EntryBounds,
  hashBounds,
  scanPart,
  type ScanResult,
  resolveDeltas,
  type DeltaBase,
  type DeltaJob,
  type DeltaResolved,
} from "../Protocol/PartialScan.ts";
import {
  ObjectTooLargeError,
  PackFormatError,
} from "../Protocol/PackParser.ts";

export {
  decodeBoundsRequest,
  decodeScanResult,
  encodeBoundsRequest,
  encodeScanResult,
  frame,
  HASH_ROUTE,
  HashError,
  makeFrameReader,
} from "./Protocol.ts";
import {
  decodeDeltaResults,
  decodeScanResult,
  encodeBoundsRequest,
  encodeDeltaBatch,
  frame,
  HASH_ROUTE,
  HashError,
  makeFrameReader,
} from "./Protocol.ts";

export interface HashPartOptions {
  /** Pack-relative offset of `payload[skip]`. */
  readonly base: number;
  readonly remaining: number;
  readonly maxObjectSize: number;
  /** The payload is a raw chunk: find the first boundary first (DESIGN §22.9). */
  readonly resync?: boolean | undefined;
  /**
   * Scanning starts at `payload[skip]`; the bytes before it (the request's
   * command section and the pack header, in a body-aligned first part) are
   * spilled but not scanned.
   */
  readonly skip?: number | undefined;
  /**
   * Write the WHOLE payload as this part of a multipart upload while
   * scanning it (DESIGN §22.10): the hasher isolate is the spill's writer,
   * so the receiver sends each byte out once.
   */
  readonly spill?:
    | {
        readonly key: string;
        readonly uploadId: string;
        readonly partNumber: number;
      }
    | undefined;
}

/**
 * A scan plus, when a spill was requested, the uploaded part's identity —
 * DEFERRED: the scan is available as soon as the hasher has it, while the
 * part's upload to blob storage may still be in flight (DESIGN §22.9).
 */
export interface HashPartResult extends ScanResult {
  readonly part?: Effect.Effect<UploadedPart, HashError> | undefined;
}

export interface HasherShape {
  /**
   * Whether `hashPart` honors `spill` by writing the part itself. A hasher
   * that cannot reach blob storage (a Lambda) answers false; the pump then
   * uploads the spill parts from its retained bytes.
   */
  readonly writesSpill: boolean;
  /**
   * The chunk size this hasher wants (a divisor of the spill part size,
   * 8 MiB); a Lambda is bounded by its 6 MB invoke payload. Default: the
   * spill part size.
   */
  readonly chunkBytes?: number | undefined;
  /** Chunks this hasher can verify at once (the pump's dispatch gate). */
  readonly concurrency?: number | undefined;
  readonly hashPart: (
    payload: Uint8Array,
    options: HashPartOptions,
  ) => Effect.Effect<
    HashPartResult,
    HashError | PackFormatError | ObjectTooLargeError
  >;
  /**
   * Applies a batch of deltas whose bases the caller supplies (DESIGN
   * §22.13): the cross-chunk and thin deltas the scan left unresolved.
   */
  readonly resolveDeltas: (
    bases: ReadonlyArray<DeltaBase>,
    jobs: ReadonlyArray<DeltaJob>,
    options: { readonly maxObjectSize: number },
  ) => Effect.Effect<
    Array<DeltaResolved>,
    HashError | PackFormatError | ObjectTooLargeError
  >;
  /**
   * The parallel half (DESIGN §22.8): hash entries whose spans the caller
   * already found with `scanBounds`. Parts hashed this way have no chain
   * between them.
   */
  readonly hashBoundsPart: (
    payload: Uint8Array,
    bounds: ReadonlyArray<EntryBounds>,
    options: { readonly base: number; readonly maxObjectSize: number },
  ) => Effect.Effect<
    ScanResult,
    HashError | PackFormatError | ObjectTooLargeError
  >;
}

export class Hasher extends Context.Service<Hasher, HasherShape>()(
  "alchemy/Git/Hasher",
) {}

/** The in-process hasher: scans here; a requested spill part goes to `blobs`. */
export const makeInlineHasher = (blobs: BlobStoreShape): HasherShape => ({
  writesSpill: true,
  hashPart: (payload, options) =>
    Effect.gen(function* () {
      const spill = options.spill;
      // Detached: the caller's fiber ends with the scan; the part is joined
      // later, before the multipart upload is completed.
      const upload =
        spill === undefined
          ? undefined
          : yield* Effect.forkDetach(
              blobs
                .uploadPart(
                  spill.key,
                  spill.uploadId,
                  spill.partNumber,
                  payload,
                )
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new HashError({
                        reason: `spill part ${spill.partNumber}: ${error.reason}`,
                      }),
                  ),
                  Effect.provide(RuntimeContext.phantom),
                ),
            );
      const skip = options.skip ?? 0;
      const scan = yield* scanPart(
        skip === 0 ? payload : payload.subarray(skip),
        options,
      );
      return {
        ...scan,
        part: upload === undefined ? undefined : Fiber.join(upload),
      };
    }),
  resolveDeltas: (bases, jobs, options) => resolveDeltas(bases, jobs, options),
  hashBoundsPart: (payload, bounds, options) =>
    hashBounds(payload, bounds, options),
});

/** Runs the scan in-process (tests, or a deployment without a self binding). */
export const HasherInline: Layer.Layer<Hasher, never, BlobStore> = Layer.effect(
  Hasher,
  Effect.map(BlobStore, makeInlineHasher),
);

/**
 * Request framing for the bounds mode: `u32 jsonLength | json(bounds) |
 * bytes`.
 */
/** The `env` name of the self service binding (`GIT_WORKER_OPTIONS`). */
/**
 * The secret the push pipeline's internal hash route requires: a
 * deploy-time random value bound onto the Worker (an `Alchemy.Random`
 * resource, minted once and stable across deploys). Yielded at layer build
 * by both the route and the self-calling hasher, so no user credential is
 * ever involved.
 */
export const InternalSecret: Effect.Effect<
  Effect.Effect<Redacted.Redacted<string>>
> = Effect.gen(function* () {
  // Yielding the resource class gives a constructor whose providers are
  // the host stack's (the same way the Cloudflare `*Http` bindings mint
  // tokens), so declaring the secret here needs nothing from the caller.
  const R = yield* Random;
  const resource = yield* R("GitInternalSecret");
  return yield* resource.text;
});

export const HASHER_BINDING = "GIT_SELF";

// ── self-binding layer ──────────────────────────────────────────────────────

interface SelfFetcher {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Posts each part to the Worker's own hash route through the self service
 * binding (`GIT_WORKER_OPTIONS` declares it as `GIT_SELF`). The internal
 * call authenticates with {@link InternalSecret}, a deploy-time random
 * value no user ever holds. Falls back to {@link HasherInline} when the
 * binding is absent from the environment.
 */
export const HasherSelf: Layer.Layer<
  Hasher,
  never,
  WorkerEnvironment | BlobStore
> = Layer.effect(
  Hasher,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const blobs = yield* BlobStore;
    const fetcher = (env as Record<string, unknown>)[HASHER_BINDING] as
      | SelfFetcher
      | undefined;
    if (fetcher === undefined) {
      return makeInlineHasher(blobs);
    }
    const secret = yield* InternalSecret;
    const send = (url: string, body: Uint8Array) =>
      Effect.gen(function* () {
        const token = Redacted.value(yield* secret);
        const response = yield* Effect.tryPromise({
          try: () =>
            fetcher.fetch(url, {
              method: "POST",
              headers: {
                "content-type": "application/octet-stream",
                authorization: `Bearer ${token}`,
              },
              body: body as unknown as BodyInit,
            }),
          catch: (error) =>
            new HashError({ reason: `hash part fetch: ${String(error)}` }),
        });
        if (response.status !== 200 || response.body === null) {
          const text = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: () => new HashError({ reason: "hash part: unreadable" }),
          });
          return yield* new HashError({
            reason: `hash part: status ${response.status}: ${text.slice(0, 200)}`,
          });
        }
        return makeFrameReader(response.body);
      });
    const post = (url: string, body: Uint8Array) =>
      Effect.gen(function* () {
        const next = yield* send(url, body);
        const first = yield* next();
        if (first === undefined) {
          return yield* new HashError({ reason: "hash part: empty response" });
        }
        return decodeScanResult(first);
      });
    return {
      writesSpill: true,
      hashPart: (payload, opts) =>
        Effect.gen(function* () {
          const spill =
            opts.spill === undefined
              ? ""
              : `&key=${encodeURIComponent(opts.spill.key)}&uploadId=${encodeURIComponent(opts.spill.uploadId)}&part=${opts.spill.partNumber}`;
          const next = yield* send(
            `https://self${HASH_ROUTE}?base=${opts.base}&remaining=${opts.remaining}&max=${opts.maxObjectSize}${opts.resync ? "&resync=1" : ""}${opts.skip ? `&skip=${opts.skip}` : ""}${spill}`,
            payload,
          );
          const first = yield* next();
          if (first === undefined) {
            return yield* new HashError({
              reason: "hash part: empty response",
            });
          }
          const scan = decodeScanResult(first);
          if (opts.spill === undefined) return scan;
          // The part frame arrives once the hasher's upload has finished.
          const part = next().pipe(
            Effect.flatMap((bytes) =>
              bytes === undefined
                ? Effect.fail(
                    new HashError({ reason: "hash part: no part frame" }),
                  )
                : Effect.succeed(
                    JSON.parse(new TextDecoder().decode(bytes)) as UploadedPart,
                  ),
            ),
          );
          return { ...scan, part };
        }),
      hashBoundsPart: (payload, bounds, opts) =>
        post(
          `https://self${HASH_ROUTE}?mode=bounds&base=${opts.base}&max=${opts.maxObjectSize}`,
          encodeBoundsRequest(payload, bounds),
        ),
      resolveDeltas: (bases, jobs, opts) =>
        Effect.gen(function* () {
          const next = yield* send(
            `https://self${HASH_ROUTE}?mode=deltas&max=${opts.maxObjectSize}`,
            encodeDeltaBatch(bases, jobs),
          );
          const first = yield* next();
          if (first === undefined) {
            return yield* new HashError({
              reason: "delta batch: empty response",
            });
          }
          return decodeDeltaResults(first);
        }),
    };
  }),
);
