// @effect-diagnostics nodeBuiltinImport:off - Previews read through a FileHandle so the file's
// identity can be checked on the same descriptor before and after the read.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { modelPreviewFormat, type ModelPreviewFormat } from "@t3tools/shared/filePreview";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { MODEL_VIEWER_MAX_TRIANGLES } from "@t3tools/shared/meshFiles";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { exportBlendWithBlender } from "./blenderRender.ts";
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
const BLENDER_RENDER_SIZE = 512;
// Blender runs take seconds, so their output persists across restarts; the oldest is removed first.
const BLENDER_CACHE_MAX_ENTRIES = 16;
const MACOS_BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender";

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
 * Estimated peak memory for a preview in MiB, measured at the size limits. Blender thumbnails are
 * read in small pieces; meshes hold the file plus their geometry, up to about 2.5 times the file,
 * and a compressed 3MF expands to about six times.
 */
const estimatedMemoryMib = (key: CacheKey) => {
  if (key.format === "blend") return 1;
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
     * PNG preview of the 3D file at `path`: its saved thumbnail or a render of its geometry, or
     * `null` when it has neither. `path` must already be authorized; `identity` pins the file a
     * token was issued for.
     */
    readonly png: (path: string, identity?: FileIdentity) => Effect.Effect<Uint8Array | null>;
    /**
     * Path of a binary PLY holding the visible geometry of the `.blend` file at `path`, exported
     * by an installed Blender for the 3D view, or `null` without Blender or anything to draw.
     * `path` must already be authorized; `identity` pins the file a token was issued for.
     */
    readonly blendGeometry: (path: string, identity?: FileIdentity) => Effect.Effect<string | null>;
  }
>()("t3/assets/ModelPreviews") {}

export interface ModelPreviewsOptions {
  /**
   * Blender used to render `.blend` files whose saved thumbnail is missing or blank: found on
   * `PATH` (or in /Applications on macOS) with `"auto"`, never with `"off"`, or at a given path.
   */
  readonly blender: "auto" | "off" | { readonly path: string };
}

const fileExists = (filePath: string) =>
  Effect.promise(() =>
    NodeFSP.stat(filePath).then(
      (info) => info.isFile(),
      () => false,
    ),
  );

/** Keeps the newest runs' outputs; a count bound is enough because each file is bounded in size. */
const pruneCache = (directory: string, maxEntries: number) =>
  Effect.promise(async () => {
    const names = (await NodeFSP.readdir(directory)).filter((name) => !name.startsWith("."));
    const newest = new Map<string, number>();
    for (const name of names) {
      const modified = (await NodeFSP.stat(NodePath.join(directory, name))).mtimeMs;
      const stem = NodePath.parse(name).name;
      newest.set(stem, Math.max(newest.get(stem) ?? 0, modified));
    }
    if (newest.size <= maxEntries) return;
    const stale = new Set(
      [...newest]
        .sort((a, b) => b[1] - a[1])
        .slice(maxEntries)
        .map(([stem]) => stem),
    );
    await Promise.all(
      names
        .filter((name) => stale.has(NodePath.parse(name).name))
        .map((name) => NodeFSP.rm(NodePath.join(directory, name), { force: true })),
    );
  }).pipe(Effect.ignore);

/** @public */
export const makeWith = Effect.fn("ModelPreviews.make")(function* (options: ModelPreviewsOptions) {
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const semaphore = yield* Semaphore.make(PREVIEW_CONCURRENCY);
  const memory = yield* Semaphore.make(PREVIEW_MEMORY_BUDGET_MIB);
  const blenderSemaphore = yield* Semaphore.make(1);
  const blenderDirectory = NodePath.join(config.providerStatusCacheDir, "model-blender");

  const findBlender = yield* Effect.cachedWithTTL(
    Effect.gen(function* () {
      if (options.blender === "off") return null;
      if (options.blender !== "auto") return options.blender.path;
      const onPath = yield* resolveCommandPath("blender").pipe(Effect.orElseSucceed(() => null));
      if (onPath) return onPath;
      return platform === "darwin" && (yield* fileExists(MACOS_BLENDER)) ? MACOS_BLENDER : null;
    }),
    "1 minute",
  );

  /**
   * Runs Blender once per file revision, keeping its render and geometry in `blenderDirectory`, and
   * returns their paths, or `null` without Blender or when it drew nothing. Geometry is `null` past
   * the 3D view's triangle limit. The render is written last, so it marks a finished run.
   */
  const blenderOutputs = Effect.fn("ModelPreviews.blenderOutputs")(function* (key: CacheKey) {
    const blender = yield* findBlender;
    if (blender === null) return null;
    const name = NodeCrypto.createHash("sha256")
      .update(`${key.path}\0${key.revision}\0${blender}`)
      .digest("hex");
    const png = NodePath.join(blenderDirectory, `${name}.png`);
    const geometry = NodePath.join(blenderDirectory, `${name}.ply`);
    const finished = Effect.gen(function* () {
      if (!(yield* fileExists(png))) return null;
      return { png, geometry: (yield* fileExists(geometry)) ? geometry : null };
    });
    const cached = yield* finished;
    if (cached) return cached;

    yield* Effect.tryPromise({
      try: () => NodeFSP.mkdir(blenderDirectory, { recursive: true }),
      catch: (cause) => new ModelPreviewReadError({ path: key.path, cause }),
    });
    const temporary = NodePath.join(blenderDirectory, `.${name}-${NodeCrypto.randomUUID()}`);
    return yield* Effect.gen(function* () {
      // Another request may have run Blender while this one waited for it.
      const ready = yield* finished;
      if (ready) return ready;
      const exitCode = yield* exportBlendWithBlender({
        blender,
        source: key.path,
        geometry: `${temporary}.ply`,
        png: `${temporary}.png`,
        maxTriangles: MODEL_VIEWER_MAX_TRIANGLES,
        size: BLENDER_RENDER_SIZE,
      }).pipe(Effect.mapError((cause) => new ModelPreviewReadError({ path: key.path, cause })));
      if (exitCode !== 0 || !(yield* fileExists(`${temporary}.png`))) return null;
      const after = yield* Effect.tryPromise({
        try: () => NodeFSP.stat(key.path, { bigint: true }),
        catch: (cause) => new ModelPreviewReadError({ path: key.path, cause }),
      });
      if (revisionOf(after) !== key.revision) {
        return yield* new ModelPreviewSourceChangedError({ path: key.path });
      }
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.rename(`${temporary}.ply`, geometry).catch(() => undefined);
          await NodeFSP.rename(`${temporary}.png`, png);
        },
        catch: (cause) => new ModelPreviewReadError({ path: key.path, cause }),
      });
      yield* pruneCache(blenderDirectory, BLENDER_CACHE_MAX_ENTRIES);
      return yield* finished;
    }).pipe(
      Effect.ensuring(
        Effect.promise(() =>
          Promise.all([
            NodeFSP.rm(`${temporary}.ply`, { force: true }),
            NodeFSP.rm(`${temporary}.png`, { force: true }),
          ]),
        ),
      ),
      blenderSemaphore.withPermits(1),
    );
  });

  // Geometry requests run outside the cache, so they need the services captured here.
  const blenderServices =
    yield* Effect.context<Effect.Services<ReturnType<typeof blenderOutputs>>>();

  const renderWithBlender = (key: CacheKey) =>
    blenderOutputs(key).pipe(
      Effect.flatMap((outputs) =>
        outputs === null
          ? Effect.succeed(null)
          : Effect.tryPromise({
              try: () => NodeFSP.readFile(outputs.png),
              catch: (cause) => new ModelPreviewReadError({ path: key.path, cause }),
            }).pipe(Effect.map((bytes) => new Uint8Array(bytes))),
      ),
    );

  const preview = (key: CacheKey) =>
    semaphore
      .withPermits(1)(memory.withPermits(estimatedMemoryMib(key))(previewUncached(key)))
      .pipe(
        Effect.timeout(PREVIEW_TIMEOUT),
        Effect.filterOrElse(
          (png) => png !== null || key.format !== "blend",
          () => renderWithBlender(key),
        ),
      );

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

  const blendGeometry = Effect.fn("ModelPreviews.blendGeometry")(
    function* (path: string, identity?: FileIdentity) {
      if (modelPreviewFormat(path) !== "blend") return null;
      const key = yield* keyOf(path, "blend", identity);
      if (key === null) return null;
      return (yield* blenderOutputs(key))?.geometry ?? null;
    },
    (effect, path) =>
      effect.pipe(
        Effect.provide(blenderServices),
        Effect.tapError((cause) =>
          Effect.logDebug("Failed to export a .blend file's geometry.", { path, cause }),
        ),
        Effect.orElseSucceed(() => null),
      ),
  );

  return ModelPreviews.of({ png, blendGeometry });
});

export const layer = Layer.effect(ModelPreviews, makeWith({ blender: "auto" }));

export const layerWith = (options: ModelPreviewsOptions) =>
  Layer.effect(ModelPreviews, makeWith(options));
