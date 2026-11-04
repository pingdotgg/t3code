// @effect-diagnostics nodeBuiltinImport:off - Previews read through a FileHandle so the file's
// identity can be checked on the same descriptor before and after the read.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { modelPreviewFormat, type ModelPreviewFormat } from "@t3tools/shared/filePreview";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { modelPreviewPng } from "./modelPreview.ts";

const PREVIEW_TIMEOUT = "10 seconds";
const PREVIEW_CONCURRENCY = 2;
/**
 * Memory, in MiB, that previews in progress may use together. Each preview reserves an estimate
 * from its file size, so one large mesh runs alone while small files still render side by side.
 */
const PREVIEW_MEMORY_BUDGET_MIB = 160;
const CACHE_MAX_ENTRIES = 32;
const CACHE_TTL = Duration.minutes(10);
// Bump when preview output changes so cached results from older code are not reused.
const PREVIEW_VERSION = 1;

class ModelPreviewReadError extends Schema.TaggedError<ModelPreviewReadError>()(
  "ModelPreviewReadError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to make a preview of '${this.path}'.`;
  }
}

class ModelPreviewSourceChangedError extends Schema.TaggedError<ModelPreviewSourceChangedError>()(
  "ModelPreviewSourceChangedError",
  { path: Schema.String },
) {
  override get message(): string {
    return `'${this.path}' changed while its preview was made.`;
  }
}

interface FileIdentity {
  readonly device: string;
  readonly inode: string;
}

interface CacheKey extends FileIdentity {
  readonly path: string;
  readonly format: ModelPreviewFormat;
  readonly revision: string;
  readonly size: number;
}

/**
 * Estimated peak memory for a preview in MiB, measured at the size limits. Meshes hold the file
 * plus their geometry, up to about 2.5 times the file, and a compressed 3MF expands to about six
 * times.
 */
const estimatedMemoryMib = (key: CacheKey) => {
  const factor = key.format === "3mf" ? 6 : 2.5;
  return Math.min(
    PREVIEW_MEMORY_BUDGET_MIB,
    Math.max(1, Math.ceil((key.size * factor) / (1024 * 1024))),
  );
};

const revisionOf = (info: NodeFS.BigIntStats) =>
  `${PREVIEW_VERSION}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

const encodeKey = (key: CacheKey) => JSON.stringify(key);

const matchesIdentity = (info: NodeFS.BigIntStats, identity: FileIdentity | undefined) =>
  identity === undefined ||
  (info.dev.toString() === identity.device && info.ino.toString() === identity.inode);

const previewUncached = (key: CacheKey) =>
  Effect.tryPromise({
    try: async (signal) => {
      // Non-blocking open prevents a swapped-in FIFO from hanging the read.
      const handle = await NodeFSP.open(
        key.path,
        NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
      );
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || revisionOf(before) !== key.revision) return "changed" as const;
        const png = await modelPreviewPng(key.format, handle, Number(before.size), signal);
        const after = await handle.stat({ bigint: true });
        return revisionOf(after) === key.revision ? png : ("changed" as const);
      } finally {
        await handle.close();
      }
    },
    catch: (cause) => new ModelPreviewReadError({ path: key.path, cause }),
  }).pipe(
    Effect.filterOrFail(
      (result): result is Uint8Array | null => result !== "changed",
      () => new ModelPreviewSourceChangedError({ path: key.path }),
    ),
  );

export class ModelPreviews extends Context.Service<
  ModelPreviews,
  {
    /**
     * PNG render of the 3D file at `path`, or `null` when it has nothing to show. `path` must
     * already be authorized; `identity` pins the file a token was issued for.
     */
    readonly png: (path: string, identity?: FileIdentity) => Effect.Effect<Uint8Array | null>;
  }
>()("t3/assets/ModelPreviews") {}

/** @public */
export const make = Effect.gen(function* () {
  const semaphore = yield* Semaphore.make(PREVIEW_CONCURRENCY);
  const memory = yield* Semaphore.make(PREVIEW_MEMORY_BUDGET_MIB);

  const preview = (key: CacheKey) =>
    semaphore
      .withPermits(1)(memory.withPermits(estimatedMemoryMib(key))(previewUncached(key)))
      .pipe(Effect.timeout(PREVIEW_TIMEOUT));

  // Concurrent requests for one revision share a lookup; files without a preview cache `null`.
  const cache = yield* Cache.makeWith(
    (encodedKey: string) => preview(JSON.parse(encodedKey) as CacheKey),
    {
      capacity: CACHE_MAX_ENTRIES,
      timeToLive: Exit.match({ onSuccess: () => CACHE_TTL, onFailure: () => Duration.zero }),
    },
  );

  /** The cache key of the authorized file at `path`, or `null` when it is not that file. */
  const keyOf = (path: string, format: ModelPreviewFormat, identity: FileIdentity | undefined) =>
    Effect.tryPromise({
      try: () => NodeFSP.stat(path, { bigint: true }),
      catch: (cause) => new ModelPreviewReadError({ path, cause }),
    }).pipe(
      Effect.map((info): CacheKey | null =>
        !info.isFile() || !matchesIdentity(info, identity)
          ? null
          : {
              path,
              format,
              device: info.dev.toString(),
              inode: info.ino.toString(),
              revision: revisionOf(info),
              size: Number(info.size),
            },
      ),
    );

  const png = Effect.fn("ModelPreviews.png")(
    function* (path: string, identity?: FileIdentity) {
      const format = modelPreviewFormat(path);
      if (format === null) return null;
      const key = yield* keyOf(path, format, identity);
      return key === null ? null : yield* Cache.get(cache, encodeKey(key));
    },
    (effect, path) =>
      effect.pipe(
        Effect.tapError((cause) =>
          Effect.logDebug("Failed to make a 3D file preview.", { path, cause }),
        ),
        Effect.orElseSucceed(() => null),
      ),
  );

  return ModelPreviews.of({ png });
});

export const layer = Layer.effect(ModelPreviews, make);
