/**
 * Git's HTTP handlers and native Effect route layers.
 *
 * ApiLive registers the public REST, smart-HTTP, and GitHub routes on the
 * application's HttpRouter. InternalApiLive registers internal hashing.
 * ApiHandlersLive shares the registry, repository clients, and cache across groups.
 * The application owns its API, authentication, HTTP server, and CORS policy.
 *
 * ```typescript
 * const PublicRoutes = Layer.mergeAll(AppApiLive, Git.ApiLive).pipe(
 *   Layer.provide(Authentication.layer),
 * );
 * const Routes = Layer.mergeAll(PublicRoutes, Git.InternalApiLive).pipe(
 *   Layer.provide(Git.ApiHandlersLive),
 *   Layer.provide(Git.ReposDurableObject),
 *   Layer.provide(Git.RegistryDurableObject),
 *   Layer.provide(Git.HasherInline),
 *   Layer.provide(Git.BlobStoreR2(GitObjects)),
 *   Layer.provide(Http.Platform),
 * );
 * const fetch = yield* HttpRouter.toHttpEffect(Routes);
 * return { fetch };
 * ```
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import crypto from "node:crypto";
import * as Cloudflare from "../Cloudflare/index.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import { GitApi, InternalApi, RepoCreated } from "./Api.ts";
import { BlobStore, type BlobStoreError } from "./BlobStore.ts";
import { Engine, EngineLive } from "./Engine.ts";
import { gitHubCompatRoutes } from "./GitHubCompat.ts";
import {
  decodeBoundsRequest,
  encodeScanResult,
  frame,
  Hasher,
  HASHER_BINDING,
  InternalSecret,
} from "./Hasher/Hasher.ts";
import { decodeDeltaBatch, encodeDeltaResults } from "./Hasher/Protocol.ts";
import * as ReceivePackHttp from "./Http/ReceivePack.ts";
import { bundleCovers, type BundleInfo } from "./Jobs/Bundle.ts";
import { Operations } from "./Operations.ts";
import { concatBytes, utf8Decode } from "./Protocol/ObjectCodec.ts";
import { hashBounds, resolveDeltas, scanPart } from "./Protocol/PartialScan.ts";
import { decodePktLines, flushPkt, pktText } from "./Protocol/Pkt.ts";
import {
  progressMessage,
  pumpPackBody,
  wrapSideband,
} from "./Protocol/Sideband.ts";
import { RegistryStore } from "./RegistryObject.ts";
import {
  buildAdvertisement,
  BUNDLE_COUNT_HEADER,
  BUNDLE_HASH_HEADER,
  BUNDLE_KEY_HEADER,
  BUNDLE_SIDEBAND_HEADER,
  GitRepo,
  GitRepoLive,
  isolatePushGate,
  parseUploadPackRequest,
  RepoStore,
  WWW_AUTHENTICATE,
} from "./RepoObject.ts";
import { decodeHeadSnapshot } from "./Store/HeadSnapshot.ts";
import { headKey } from "./Store/Keys.ts";

/** A `Bearer` credential from the `Authorization` header (the hash route's internal secret). */
const parseBearer = (
  headers: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const authorization = headers.authorization;
  if (authorization === undefined) return undefined;
  const space = authorization.indexOf(" ");
  if (space === -1) return undefined;
  if (authorization.slice(0, space).toLowerCase() !== "bearer")
    return undefined;
  const credential = authorization.slice(space + 1).trim();
  return credential === "" ? undefined : credential;
};

const sha256 = (input: string): Uint8Array => {
  const digest = crypto.createHash("sha256").update(input).digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
};

/** Timing-safe string equality over sha-256 digests. */
const timingSafeEqual = (a: string, b: string): Effect.Effect<boolean> =>
  Effect.sync(() => crypto.timingSafeEqual(sha256(a), sha256(b)));

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// The Worker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The git-service Worker. Hosts the `GitRepo` and `GitRegistry` Durable
 * Objects (their Live layers are provided on this Worker's init effect)
 * plus the shared R2 objects bucket binding, and serves both the REST
 * management plane and the git smart-HTTP wire protocol.
 *
 * Requires `nodejs_compat` (node:zlib / node:crypto in the DO) and a
 * raised CPU limit (`cpu_ms: 300_000`) — pack inflation cannot run under
 * the free plan's 10 ms budget (DESIGN.md §1).
 */
/**
 * Worker options every Git host needs: `nodejs_compat` (zlib +
 * crypto in the codec layer) and a generous CPU ceiling for pack ingest.
 * Spread into your `Cloudflare.Worker` definition.
 */
export const GIT_WORKER_OPTIONS = {
  compatibility: {
    flags: ["nodejs_compat"] as Array<"nodejs_compat">,
    date: "2026-03-17",
  },
  limits: { cpuMs: 300_000 },
  // The push pipeline hashes each spilled part in a fresh isolate of this
  // same script through a self service binding (DESIGN §22.7, Hasher.ts).
  env: { [HASHER_BINDING]: Cloudflare.Workers.Self },
};

const makeCore = Effect.gen(function* () {
  // ── init: DO namespaces ────────────────────────────────────────────────
  // RPC-boundary tagged errors are reconstructed by the stubs themselves —
  // both DO classes declare `errors: [...]` (see DurableObjectProps.errors).
  const registry = yield* RegistryStore;
  const repos = yield* RepoStore;
  // The Worker streams clone bundles straight out of R2 (DESIGN.md §11):
  // the DO plans the clone, the bytes bypass it entirely.
  // The Worker-side view of the blob store (clone-bundle splice reads)
  // — the same BlobStore layer the Repo DO consumes.
  const workerBlobs = yield* BlobStore;
  const engine = yield* Engine;
  const internalSecret = yield* InternalSecret;
  // The push pipeline's verifier (DESIGN §22.10): pack parts are inflated
  // and hashed by this service — fanned out across Worker invocations by
  // `HasherSelf`, inline under `HasherInline`.
  const hasher = yield* Hasher;
  const pushGate = yield* isolatePushGate;
  /** Staging batches in flight to the Repo DO per push (DESIGN §22.10). */
  const STAGE_CONCURRENCY = 6;

  const operations = yield* Operations;
  const {
    resolveCached,
    refs: refsRoutes,
    objects: objectsRoutes,
    pulls: pullsRoutes,
  } = operations;
  const remoteResult = <E, R>(effect: Effect.Effect<RepoCreated, E, R>) =>
    Effect.gen(function* () {
      const result = yield* effect;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const host = request.headers.host;
      return new RepoCreated({
        repo: result.repo,
        remote:
          host === undefined
            ? result.remote
            : `${request.headers["x-forwarded-proto"] ?? "https"}://${host}${result.remote}`,
      });
    });
  const reposRoutes = {
    ...operations.repos,
    create: (input: Parameters<typeof operations.repos.create>[0]) =>
      remoteResult(operations.repos.create(input)),
    fork: (input: Parameters<typeof operations.repos.fork>[0]) =>
      remoteResult(operations.repos.fork(input)),
    import: (input: Parameters<typeof operations.repos.import>[0]) =>
      remoteResult(operations.repos.import(input)),
  };

  const wire401 = HttpServerResponse.empty({
    status: 401,
    headers: { "www-authenticate": WWW_AUTHENTICATE },
  });
  const notFound = HttpServerResponse.text("repository not found", {
    status: 404,
  });
  const internalError = HttpServerResponse.text("internal error", {
    status: 500,
  });

  /**
   * Streams a clone bundle out of the BlobStore as a complete
   * upload-pack result (NAK + optionally sideband-framed pack).
   * `undefined` when the bundle bytes are gone (GC raced us).
   */
  /**
   * Wraps pack bytes as a complete upload-pack result (NAK, optional
   * sideband framing, flush). `shape` distinguishes a bundle streamed
   * verbatim from one spliced with a delta — surfaced on
   * `x-git-served-by` so which plane answered is observable, and
   * assertable in the benchmarks.
   */
  const respondWithPack = (
    packBytes: Stream.Stream<Uint8Array, BlobStoreError>,
    options: {
      readonly refsHash: string;
      readonly objectCount: number;
      readonly sideband: boolean;
      readonly via: "do-bundle" | "head-snapshot";
      /** The store's native stream, when it has one (R2 does). */
      readonly readable?: ReadableStream<Uint8Array> | undefined;
      /** `readable` is the pre-framed twin (sideband only). */
      readonly framed?: boolean | undefined;
    },
    shape: "bundle",
  ) => {
    const nak = pktText("NAK");
    const headers = {
      "cache-control": "no-cache",
      "x-git-served-by": `${options.via}:${shape}${options.framed === true ? "+framed" : ""}`,
      [BUNDLE_HASH_HEADER]: options.refsHash,
    };
    // Native path (DESIGN §22): R2's own stream pipes into the Response
    // through web streams only. The bundle bytes never enter an Effect
    // stream, so there is no fiber hand-off per chunk — that hand-off
    // was measured as the ceiling on clone throughput. Sideband framing
    // is a TransformStream emitting 5-byte headers + subarrays (no copy);
    // the raw case is an IdentityTransformStream, which workerd pipes
    // without JS touching the bytes at all.
    if (options.readable !== undefined) {
      const source = options.readable;
      const prefix = options.sideband
        ? concatBytes([
            nak,
            progressMessage(
              `Enumerating objects: ${options.objectCount}, done.`,
            ),
          ])
        : nak;
      const out = pumpPackBody({
        prefix,
        source,
        sideband: options.sideband,
        framed: options.framed,
      });
      return HttpServerResponse.raw(out, {
        contentType: "application/x-git-upload-pack-result",
        headers,
      });
    }
    const body = options.sideband
      ? Stream.fromArray([
          nak,
          progressMessage(`Enumerating objects: ${options.objectCount}, done.`),
        ]).pipe(
          Stream.concat(packBytes.pipe(wrapSideband(1))),
          Stream.concat(Stream.succeed(flushPkt)),
        )
      : Stream.fromArray([nak]).pipe(Stream.concat(packBytes));
    return HttpServerResponse.stream(body, {
      contentType: "application/x-git-upload-pack-result",
      headers,
    });
  };

  const serveBundle = Effect.fn(function* (options: {
    readonly key: string;
    readonly refsHash: string;
    readonly objectCount: number;
    readonly sideband: boolean;
    /** Which plane produced the plan — observability + bench assertions. */
    readonly via: "do-bundle" | "head-snapshot";
  }) {
    if (options.sideband) {
      // Prefer the pre-framed twin: a pure platform pipe (Keys.ts).
      const framed = yield* Effect.result(
        workerBlobs.get(options.key.replace(/\.pack$/, ".sideband")),
      );
      if (
        Result.isSuccess(framed) &&
        framed.success !== null &&
        framed.success.readable !== undefined
      ) {
        return respondWithPack(
          framed.success.stream,
          { ...options, readable: framed.success.readable, framed: true },
          "bundle",
        );
      }
    }
    const object = yield* Effect.result(workerBlobs.get(options.key));
    if (Result.isFailure(object) || object.success === null) {
      return undefined;
    }
    return respondWithPack(
      object.success.stream,
      { ...options, readable: object.success.readable },
      "bundle",
    );
  });

  /**
   * The DO-less read path (DESIGN.md §21): the upload-pack
   * advertisement and bundle-covered full clones served straight from
   * the repo's head snapshot in the BlobStore — the Repo DO never
   * wakes, so read throughput scales with Workers + blob storage
   * instead of one single-threaded object.
   *
   * `undefined` = not eligible; the caller forwards to the DO. Access
   * was decided before the route ran, by the middleware applied to its route layer — this changes WHERE the bytes come from, never who
   * gets them.
   */
  const headSnapshotFastPath = Effect.fn(function* (
    request: HttpServerRequest.HttpServerRequest,
    repoId: string,
  ) {
    const target = new URL(request.url, "http://wire");
    const isAdvertisement =
      request.method === "GET" &&
      target.pathname.endsWith("/info/refs") &&
      target.searchParams.get("service") === "git-upload-pack";
    const isUploadPack =
      request.method === "POST" && target.pathname.endsWith("/git-upload-pack");
    if (!isAdvertisement && !isUploadPack) return undefined;
    // Compressed bodies carry big negotiation rounds — the DO owns
    // those (and the gunzip) anyway.
    if (isUploadPack && request.headers["content-encoding"] !== undefined) {
      return undefined;
    }

    const object = yield* Effect.result(workerBlobs.get(headKey(repoId)));
    if (Result.isFailure(object) || object.success === null) {
      return undefined;
    }
    const raw = yield* Effect.result(object.success.bytes);
    if (Result.isFailure(raw)) return undefined;
    const snapshot = decodeHeadSnapshot(utf8Decode(raw.success));
    if (snapshot === undefined) return undefined;

    if (isAdvertisement) {
      return HttpServerResponse.uint8Array(
        buildAdvertisement({
          service: "git-upload-pack",
          defaultBranch: snapshot.defaultBranch,
          refs: snapshot.refs,
        }),
        {
          contentType: "application/x-git-upload-pack-advertisement",
          headers: {
            "cache-control": "no-cache",
            "x-git-served-by": "head-snapshot",
          },
        },
      );
    }

    const bundle: BundleInfo | undefined = snapshot.bundle;
    if (bundle === undefined) return undefined;
    // Read the request body from a CLONE of the platform request so a
    // fall-through still forwards the original, unconsumed body.
    const source = request.source;
    if (!(source instanceof Request)) return undefined;
    const bodyResult = yield* Effect.result(
      Effect.tryPromise(() => source.clone().arrayBuffer()),
    );
    if (Result.isFailure(bodyResult)) return undefined;
    const req = yield* decodePktLines(new Uint8Array(bodyResult.success)).pipe(
      Effect.flatMap(parseUploadPackRequest),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (req === undefined) return undefined;
    if (
      !req.done ||
      !bundleCovers(bundle, {
        wants: req.wants,
        haves: req.haves,
        depth: req.depth,
        clientShallow: req.clientShallow,
      })
    ) {
      return undefined;
    }
    return yield* serveBundle({
      key: bundle.key,
      refsHash: bundle.refsHash,
      objectCount: bundle.objectCount,
      sideband: req.capabilities.has("side-band-64k"),
      via: "head-snapshot",
    });
  });

  const wireProxy = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const owner = (params.owner ?? "").toLowerCase();
    let repo = (params.repo ?? "").toLowerCase();
    if (repo.endsWith(".git")) repo = repo.slice(0, -4);

    const resolved = yield* Effect.result(resolveCached(owner, repo));
    if (Result.isFailure(resolved)) {
      return internalError;
    }
    const entry = resolved.success;
    if (entry === undefined) {
      return notFound;
    }

    // Reads never wake the DO when the head snapshot covers them: the
    // middleware in front of the route already decided who may read.
    const fast = yield* headSnapshotFastPath(request, entry.repoId);
    if (fast !== undefined) return fast;

    const response = yield* repos.getByName(entry.repoId).fetch(request);

    // Clone-bundle splice (DESIGN.md §11): the DO answered with a marker
    // naming an immutable R2 object rather than the pack itself. Stream
    // those bytes to the client from here, so the pack never transits
    // the Durable Object — this is what makes clone bandwidth scale with
    // Workers/R2 instead of with one single-threaded object.
    const bundleKeyHeader = response.headers[BUNDLE_KEY_HEADER];
    if (bundleKeyHeader === undefined) {
      return response;
    }
    const served = yield* serveBundle({
      key: bundleKeyHeader,
      refsHash: response.headers[BUNDLE_HASH_HEADER] ?? "",
      objectCount: Number(response.headers[BUNDLE_COUNT_HEADER] ?? "0"),
      sideband: response.headers[BUNDLE_SIDEBAND_HEADER] === "1",
      via: "do-bundle",
    });
    // The bundle vanished (GC raced us): fall back to a plain 500 — git
    // retries, and the next attempt re-plans against a fresh bundle or
    // the dynamic path.
    return served ?? internalError;
  });

  /**
   * POST git-receive-pack — the push pipeline (DESIGN §22.10). It runs
   * HERE, in the stateless Worker: the body streams into the hasher
   * fan-out and the blob-store spill as it arrives, and the Repo DO
   * receives only staged ROWS (`stagePush`, promoted rows are coordinates
   * into the wire pack) and the commit summary (`commitPush`). No pack
   * byte enters the Durable Object, so its memory, CPU and egress are
   * untouched by push size.
   */
  const receivePackRoute = Effect.scoped(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const repo = yield* engine.repositories.get({
        owner: params.owner ?? "",
        repo: params.repo ?? "",
      });
      const push = yield* ReceivePackHttp.decode(request);
      if (push._tag === "Probe") return ReceivePackHttp.probeResponse();
      return yield* Effect.gen(function* () {
        const prepared = yield* engine.preparePush(repo, push.input);
        return ReceivePackHttp.response(
          push,
          yield* engine.commitPush(prepared),
        );
      }).pipe(
        Effect.catchTag("PushDenied", (error) =>
          Effect.succeed(ReceivePackHttp.reject(push, error.reason)),
        ),
      );
    }),
  ).pipe(
    Effect.catchTag("RepoNotFound", () => Effect.succeed(notFound)),
    Effect.catchTag("StoreError", (error) =>
      Effect.succeed(ReceivePackHttp.failure(error.reason)),
    ),
    Effect.catchTag(["WireProtocolError", "PackIngestError"], (error) =>
      Effect.succeed(ReceivePackHttp.failure(error.reason)),
    ),
  );

  /** Auth + resolve for the raw REST reads; `undefined` = already replied. */
  const rawRestPrelude = (ownerRaw: string, repoRaw: string) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const resolved = yield* Effect.result(resolveCached(ownerRaw, repoRaw));
      if (Result.isFailure(resolved)) {
        return { kind: "halt", response: internalError } as const;
      }
      if (resolved.success === undefined) {
        return { kind: "halt", response: notFound } as const;
      }
      return { kind: "ok", entry: resolved.success } as const;
    });

  /**
   * `GET /api/v1/repos/:owner/:repo/blobs/:oid/raw` — raw blob bytes,
   * octet-stream, no size cap (the per-object 64 MiB ingest cap is the
   * outer bound). Outside HttpApi schema-land by design (DESIGN.md §5).
   */
  const blobRawRoute = Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const prelude = yield* rawRestPrelude(
      params.owner ?? "",
      params.repo ?? "",
    );
    if (prelude.kind === "halt") return prelude.response;
    return yield* repos
      .getByName(prelude.entry.repoId)
      .readObject({ oid: params.oid ?? "", expect: "blob" })
      .pipe(
        Effect.map((data) =>
          HttpServerResponse.uint8Array(data.content, {
            contentType: "application/octet-stream",
          }),
        ),
        Effect.catchTag(["RepoNotFound", "ObjectNotFound"], () =>
          Effect.succeed(HttpServerResponse.text("not found", { status: 404 })),
        ),
        Effect.catchTag("WrongObjectType", (error) =>
          Effect.succeed(
            HttpServerResponse.text(
              `object ${error.oid} is a ${error.actual}, not a ${error.expected}`,
              { status: 422 },
            ),
          ),
        ),
        Effect.catchTag("StoreError", () => Effect.succeed(internalError)),
      );
  });

  /**
   * `GET /api/v1/repos/:owner/:repo/file?ref=<refname|oid>&path=<path>` —
   * file-at-path bytes via tree walk, octet-stream (DESIGN.md §2.2).
   */
  const fileRoute = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const url = new URL(request.url, "http://worker");
    const path = url.searchParams.get("path");
    const ref = url.searchParams.get("ref") ?? undefined;
    if (path === null || path.length === 0) {
      return HttpServerResponse.text("missing ?path", { status: 400 });
    }
    const prelude = yield* rawRestPrelude(
      params.owner ?? "",
      params.repo ?? "",
    );
    if (prelude.kind === "halt") return prelude.response;
    return yield* repos
      .getByName(prelude.entry.repoId)
      .readFileAtPath({ ref, path })
      .pipe(
        Effect.map((file) =>
          HttpServerResponse.uint8Array(file.content, {
            contentType: "application/octet-stream",
          }),
        ),
        Effect.catchTag(["RepoNotFound", "RefNotFound", "ObjectNotFound"], () =>
          Effect.succeed(HttpServerResponse.text("not found", { status: 404 })),
        ),
        Effect.catchTag("StoreError", () => Effect.succeed(internalError)),
      );
  });

  // GitHub REST v3 compatibility facade (`gh api`, Octokit): reuses the
  // same prelude + DO stubs; auth enforcement stays in the DO.
  const githubRoutes = gitHubCompatRoutes({
    prelude: rawRestPrelude,
    stub: (repoId) => repos.getByName(repoId),
  });

  /**
   * The push pipeline's hashing endpoint (DESIGN §22.7): a spilled part (plus
   * carry) in the body, coordinates in the query; the scan result in the
   * binary form `Hasher.ts` decodes. Internal: admin-authenticated, reached
   * through the self service binding.
   */
  const hashPartRoute = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const presented = parseBearer(request.headers);
    const expected = Redacted.value(yield* internalSecret);
    if (
      presented === undefined ||
      !(yield* timingSafeEqual(presented, expected))
    ) {
      return HttpServerResponse.text("forbidden", { status: 403 });
    }
    const query = new URL(request.url, "http://x").searchParams;
    const base = Number(query.get("base"));
    const maxObjectSize = Number(query.get("max"));
    const boundsMode = query.get("mode") === "bounds";
    const remaining = boundsMode ? 0 : Number(query.get("remaining"));
    if (![base, remaining, maxObjectSize].every(Number.isFinite)) {
      return HttpServerResponse.text("bad coordinates", { status: 400 });
    }
    const t0 = Date.now();
    const body = new Uint8Array(yield* request.arrayBuffer);
    const tBody = Date.now();
    if (query.get("mode") === "deltas") {
      const { bases, jobs } = decodeDeltaBatch(body);
      const resolved = yield* resolveDeltas(bases, jobs, {
        maxObjectSize,
      }).pipe(Effect.result);
      if (Result.isFailure(resolved)) {
        return HttpServerResponse.text(
          `${resolved.failure._tag}: ${"reason" in resolved.failure ? resolved.failure.reason : ""}`,
          { status: 422 },
        );
      }
      return HttpServerResponse.uint8Array(
        frame(encodeDeltaResults(resolved.success)),
        { contentType: "application/octet-stream" },
      );
    }
    // A requested spill part uploads concurrently with the scan (DESIGN
    // §22.10): this isolate is the writer of the part it verifies.
    const key = query.get("key");
    const uploadId = query.get("uploadId");
    const partNumber = Number(query.get("part"));
    const upload =
      key !== null && uploadId !== null && Number.isFinite(partNumber)
        ? // Detached: it outlives the handler fiber, which returns as soon as
          // the scan is written; the open response stream keeps the
          // invocation alive until the part frame follows.
          yield* Effect.forkDetach(
            workerBlobs
              .uploadPart(key, uploadId, partNumber, body)
              .pipe(Effect.provide(RuntimeContext.phantom), Effect.result),
          )
        : undefined;
    const skip = Number(query.get("skip") ?? "0");
    const result = yield* (
      boundsMode
        ? Effect.suspend(() => {
            const { bounds, payload } = decodeBoundsRequest(body);
            return hashBounds(payload, bounds, { base, maxObjectSize });
          })
        : scanPart(skip > 0 ? body.subarray(skip) : body, {
            base,
            remaining,
            maxObjectSize,
            resync: query.get("resync") === "1",
          })
    ).pipe(Effect.result);
    if (Result.isFailure(result)) {
      return HttpServerResponse.text(
        `${result.failure._tag}: ${"reason" in result.failure ? result.failure.reason : ""}`,
        { status: 422 },
      );
    }
    const scanFrame = frame(encodeScanResult(result.success));
    if (upload === undefined) {
      return HttpServerResponse.uint8Array(scanFrame, {
        contentType: "application/octet-stream",
      });
    }
    // Two frames: the scan now, the part once its upload has finished —
    // the open response stream keeps this invocation alive meanwhile.
    const { readable, writable } = new IdentityTransformStream();
    const tScan = Date.now();
    // A plain async writer, like the clone pump: writes settle only as the
    // response is read, and the open stream keeps this invocation alive
    // until the part's upload has finished.
    const partDone = Effect.runPromise(Fiber.join(upload));
    yield* Effect.sync(() => {
      void (async () => {
        const writer = writable.getWriter();
        try {
          await writer.write(scanFrame);
          const part = await partDone;
          if (body.length > 1 << 20) {
            console.log(
              `[hash] bytes=${body.length} body=${tBody - t0}ms scan=${tScan - tBody}ms upload=${Date.now() - tScan}ms part=${partNumber}`,
            );
          }
          if (Result.isFailure(part)) {
            await writable
              .abort(new Error(part.failure.reason))
              .catch(() => {});
            return;
          }
          await writer.write(
            frame(new TextEncoder().encode(JSON.stringify(part.success))),
          );
          await writer.close();
        } catch (error) {
          await writable.abort(error).catch(() => {});
        }
      })();
    });
    return HttpServerResponse.raw(readable, {
      contentType: "application/octet-stream",
    });
  });

  return {
    repos: reposRoutes,
    refs: refsRoutes,
    objects: {
      ...objectsRoutes,
      blobRaw: () => blobRawRoute,
      file: () => fileRoute,
    },
    pulls: pullsRoutes,
    protocol: {
      infoRefs: () => wireProxy.pipe(Effect.orDie),
      uploadPack: () => wireProxy.pipe(Effect.orDie),
      receivePack: () => receivePackRoute.pipe(Effect.orDie),
    },
    github: githubRoutes,
    internal: {
      hashPart: () => hashPartRoute.pipe(Effect.orDie),
    },
  };
});

/**
 * Reusable HTTP handlers for each Git API group. Resolve this service while
 * building an `HttpApiBuilder.group`, then register its handlers with
 * `handleAll`. Override individual handlers with ordinary object spread.
 * The storage clients, resolve cache, and push gate are shared by all groups.
 *
 * ```typescript
 * const ReposLive = HttpApiBuilder.group(AppApi, "repos", (h) =>
 *   Effect.map(Git.Handlers, (git) => h.handleAll(git.repos)),
 * );
 * ```
 */
export class Handlers extends Context.Service<
  Handlers,
  Effect.Success<typeof makeCore>
>()("alchemy/Git/Handlers") {}

/**
 * Builds reusable Git handlers from the storage and hasher services.
 *
 * ### Implementing a group
 * **Example:** Repository handlers for an application API
 * ```typescript
 * const ReposLive = HttpApiBuilder.group(AppApi, "repos", (h) =>
 *   Effect.map(Git.Handlers, (git) => h.handleAll(git.repos)),
 * ).pipe(Layer.provide(Git.ApiHandlersLive));
 * ```
 */
export const ApiHandlersLive = Layer.effect(Handlers, makeCore).pipe(
  Layer.provideMerge(EngineLive),
);

/**
 * The internal hash group for {@link InternalApi}. {@link InternalApiLive}
 * registers it with the application router, separately from public middleware.
 */
export const InternalLive = HttpApiBuilder.group(InternalApi, "internal", (h) =>
  Effect.map(Handlers, (git) => h.handleAll(git.internal)),
);

/** Native Effect group implementations. Merge an overriding group after these when needed. */
export const GroupsLive = Layer.mergeAll(
  HttpApiBuilder.group(GitApi, "repos", (h) =>
    Effect.map(Handlers, (git) => h.handleAll(git.repos)),
  ),
  HttpApiBuilder.group(GitApi, "refs", (h) =>
    Effect.map(Handlers, (git) => h.handleAll(git.refs)),
  ),
  HttpApiBuilder.group(GitApi, "objects", (h) =>
    Effect.map(Handlers, (git) => h.handleAll(git.objects)),
  ),
  HttpApiBuilder.group(GitApi, "pulls", (h) =>
    Effect.map(Handlers, (git) => h.handleAll(git.pulls)),
  ),
  HttpApiBuilder.group(GitApi, "protocol", (h) =>
    Effect.map(Handlers, (git) => h.handleAll(git.protocol)),
  ),
  HttpApiBuilder.group(GitApi, "github", (h) =>
    Effect.map(Handlers, (git) => h.handleAll(git.github)),
  ),
);

/**
 * Git's public routes as an ordinary HttpRouter layer. Merge this with your
 * application's routes and provide your route middleware to the result.
 * The application owns its API, HTTP server, platform, and CORS policy.
 *
 * ```typescript
 * const Routes = Layer.mergeAll(AppApiLive, Git.ApiLive).pipe(
 *   Layer.provide(Authentication.layer),
 * );
 * ```
 *
 * @layer
 */
export const ApiLive = HttpApiBuilder.layer(GitApi).pipe(
  Layer.provide(GroupsLive),
);

/**
 * The authenticated internal hashing route. Mount beside public routes,
 * outside application authentication; the handler checks InternalSecret.
 *
 * @layer
 */
export const InternalApiLive = HttpApiBuilder.layer(InternalApi).pipe(
  Layer.provide(InternalLive),
);

/**
 * Hosts the `GitRepo` Durable Object (refs, objects, pulls, the wire
 * protocol) and provides {@link RepoStore} over its namespace. Requires a
 * {@link BlobStore} — provide `Git.BlobStoreR2(yourBucket)` in the same
 * layer graph; one provision serves this DO and the Worker-side reads —
 * plus the {@link Hasher} and the registry.
 *
 * @layer
 * @provides Git.RepoStore
 */
export const ReposDurableObject = Layer.effect(
  RepoStore,
  Effect.gen(function* () {
    const namespace = yield* GitRepo;
    return { getByName: (repoId) => namespace.getByName(repoId) };
  }),
).pipe(Layer.provideMerge(GitRepoLive));
