/**
 * Documents and summaries live under canvas/<projectId>; content-addressed asset files
 * keep edits from rewriting base64 images. Per-document locks serialize op batches.
 * Cached revisions flush on an interval and shutdown; persisted idle documents are evicted.
 * CanvasHostBroker routes rendering and open requests to clients.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synchronous content hashes stay inside document serialization.
import * as NodeCrypto from "node:crypto";

import {
  CANVAS_DOCUMENT_VERSION,
  CANVAS_UPLOAD_MAX_BYTES,
  CanvasAsset,
  CanvasDocument,
  CanvasDocumentSummary,
  CanvasDocumentNotFoundError,
  CanvasHostRequestFailedError,
  CanvasHostUnavailableError,
  CanvasImportError,
  CanvasNode,
  CanvasNodeNotFoundError,
  CanvasOpRejectedError,
  CanvasProjectNotFoundError,
  CanvasRevisionConflictError,
  CanvasStorageError,
  type CanvasCreateInput,
  type CanvasDocumentEvent,
  type CanvasDocumentId,
  type CanvasHostScreenshot,
  type CanvasNodeId,
  type CanvasOp,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { importCanvasInProcess } from "./CanvasImportProcess.ts";
import { applyCanvasOps, CanvasOpError, makeCanvasNodeId } from "@t3tools/shared/canvasOps";
import { HTML_RENDER_COLUMN_WIDTH, type HtmlRenderReference } from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as Semaphore from "effect/Semaphore";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CanvasHostBroker from "./CanvasHostBroker.ts";
import { builtinService } from "../plugins/PluginKernel.ts";

/** Disabled service facades refuse at invocation; transports return the declared canvas error. */
export const isCanvasDisabled = (defect: unknown) =>
  defect instanceof Error && defect.message === "Plugin 't3.canvas' is disabled.";
const canvasDisabledError = () =>
  new CanvasHostUnavailableError({ reason: "Canvas is disabled in this environment." });
export const recoverCanvasDisabled = Effect.catchDefect((defect) =>
  isCanvasDisabled(defect) ? Effect.fail(canvasDisabledError()) : Effect.die(defect),
);
export const recoverCanvasStreamDisabled = Stream.catchDefect((defect) =>
  isCanvasDisabled(defect) ? Stream.fail(canvasDisabledError()) : Stream.die(defect),
);

/** The first edit after a write schedules the next one; a steady stream writes once per interval. */
const CANVAS_PERSIST_INTERVAL = Duration.seconds(1);
const WORKSPACE_IMPORT_MAX_BYTES = 256 * 1024 * 1024;
const SAFE_DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ASSET_HASH = /^[a-f0-9]{64}$/;
/** Longest side of an agent screenshot. Provider APIs reject images past 8000 px. */
const SCREENSHOT_MAX_SIDE = 2048;

type NotFound = CanvasDocumentNotFoundError | CanvasStorageError | CanvasHostUnavailableError;

interface CanvasCreateResult {
  readonly document: CanvasDocument;
  readonly warnings: ReadonlyArray<string>;
}

/** On disk, `assets` is empty and `assetFiles` maps asset id to its content hash. */
const PersistedCanvasDocument = Schema.Struct({
  ...CanvasDocument.fields,
  assetFiles: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

/**
 * Nodes are fully validated before they are stored (ops are decoded, imports
 * are checked before the first write), so loading only checks each node's
 * identity and geometry. A full decode of a 50k-node document takes ~0.5 s.
 */
const StoredCanvasNode = Schema.declare(
  (input): input is CanvasNode =>
    typeof input === "object" &&
    input !== null &&
    "id" in input &&
    typeof input.id === "string" &&
    "type" in input &&
    typeof input.type === "string" &&
    "x" in input &&
    Number.isFinite(input.x) &&
    "y" in input &&
    Number.isFinite(input.y) &&
    "width" in input &&
    Number.isFinite(input.width) &&
    "height" in input &&
    Number.isFinite(input.height),
);
const StoredCanvasDocument = Schema.Struct({
  ...PersistedCanvasDocument.fields,
  nodes: Schema.Record(Schema.String, StoredCanvasNode),
});

/** Optional `projectId` scopes a lookup: a document from another project reads as missing. */
interface DocumentRef {
  readonly documentId: CanvasDocumentId;
  readonly projectId?: ProjectId | undefined;
}

export class CanvasService extends Context.Service<
  CanvasService,
  {
    readonly list: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<
      ReadonlyArray<CanvasDocumentSummary>,
      CanvasProjectNotFoundError | CanvasStorageError
    >;
    readonly create: <E = never>(
      input: CanvasCreateInput,
      authorize?: Effect.Effect<void, E>,
    ) => Effect.Effect<
      CanvasCreateResult,
      | CanvasProjectNotFoundError
      | CanvasImportError
      | CanvasStorageError
      | CanvasHostUnavailableError
      | E
    >;
    readonly importUpload: (input: {
      readonly projectId: ProjectId;
      readonly fileName: string;
      readonly name?: string | undefined;
      readonly body: Stream.Stream<Uint8Array, unknown>;
    }) => Effect.Effect<
      CanvasCreateResult,
      | CanvasProjectNotFoundError
      | CanvasImportError
      | CanvasStorageError
      | CanvasHostUnavailableError
    >;
    /** Imports a design file from inside the project workspace (or the thread's worktree). */
    readonly createFromWorkspaceFile: <E = never>(
      input: {
        readonly projectId: ProjectId;
        readonly workspaceRoot?: string | null | undefined;
        readonly relativePath: string;
        readonly name?: string | undefined;
      },
      authorize?: Effect.Effect<void, E>,
    ) => Effect.Effect<
      CanvasCreateResult,
      | CanvasProjectNotFoundError
      | CanvasImportError
      | CanvasStorageError
      | CanvasHostUnavailableError
      | E
    >;
    readonly get: (input: DocumentRef) => Effect.Effect<CanvasDocument, NotFound>;
    readonly delete: (input: DocumentRef) => Effect.Effect<void, NotFound>;
    readonly applyOps: <E = never>(
      input: DocumentRef & {
        readonly ops: ReadonlyArray<CanvasOp>;
        readonly clientBatchId?: string | undefined;
        readonly baseRevision?: number | undefined;
      },
      authorize?: Effect.Effect<void, E>,
    ) => Effect.Effect<
      { readonly revision: number },
      NotFound | CanvasOpRejectedError | CanvasRevisionConflictError | E
    >;
    /** First event is a snapshot; ends after a `deleted` event. */
    readonly subscribe: (input: DocumentRef) => Stream.Stream<CanvasDocumentEvent, NotFound>;
    readonly screenshot: (
      input: DocumentRef & {
        readonly nodeId?: CanvasNodeId | undefined;
        readonly scale?: number | undefined;
      },
    ) => Effect.Effect<
      CanvasHostScreenshot,
      NotFound | CanvasNodeNotFoundError | CanvasHostBroker.CanvasHostError
    >;
    /** Publishes a frozen renderer snapshot as a durable artifact in the caller's thread. */
    readonly render: (
      input: DocumentRef & {
        readonly threadId: ThreadId;
        readonly projectId: ProjectId;
        readonly nodeId?: CanvasNodeId | undefined;
        readonly scale?: number | undefined;
        readonly title?: string | undefined;
      },
    ) => Effect.Effect<
      HtmlRenderReference,
      NotFound | CanvasNodeNotFoundError | CanvasHostBroker.CanvasHostError,
      HtmlRender.HtmlRender
    >;
    readonly open: (input: {
      readonly threadId: ThreadId;
      readonly projectId?: ProjectId | undefined;
      readonly documentId?: CanvasDocumentId | undefined;
    }) => Effect.Effect<void, NotFound | CanvasHostBroker.CanvasHostError>;
  }
>()("t3/canvas/CanvasService") {}

interface Entry {
  document: CanvasDocument;
  readonly path: string;
  readonly events: PubSub.PubSub<CanvasDocumentEvent>;
  persistedRevision: number;
  subscribers: number;
  flushScheduled: boolean;
  deleted: boolean;
  /** Content hash of every asset object already on disk. */
  readonly assetHashes: WeakMap<CanvasAsset, string>;
}

const decodeStoredDocumentJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredCanvasDocument),
);
const decodeAssetJson = Schema.decodeUnknownEffect(Schema.fromJsonString(CanvasAsset));
const decodeSummaryJson = Schema.decodeUnknownEffect(Schema.fromJsonString(CanvasDocumentSummary));
const isCanvasNode = Schema.is(CanvasNode);

export const summarizeCanvasDocument = (document: CanvasDocument): CanvasDocumentSummary => ({
  id: document.id,
  projectId: document.projectId,
  name: document.name,
  revision: document.revision,
  nodeCount: Object.keys(document.nodes).length,
  updatedAt: document.updatedAt,
});

/** A document split into its on-disk parts; only assets missing from `assetHashes` are serialized. */
function serializeDocument(document: CanvasDocument, assetHashes: WeakMap<CanvasAsset, string>) {
  const assetFiles: Record<string, string> = {};
  const newAssets: Array<{
    readonly asset: CanvasAsset;
    readonly hash: string;
    readonly json: string;
  }> = [];
  for (const [id, asset] of Object.entries(document.assets)) {
    let hash = assetHashes.get(asset);
    if (hash === undefined) {
      const json = JSON.stringify(asset);
      hash = NodeCrypto.createHash("sha256").update(json).digest("hex");
      newAssets.push({ asset, hash, json });
    }
    assetFiles[id] = hash;
  }
  return {
    documentJson: JSON.stringify({ ...document, assets: {}, assetFiles }),
    summaryJson: JSON.stringify(summarizeCanvasDocument(document)),
    newAssets,
  };
}

/** Longest side, in canvas units, of one node's box or of all top-level boxes (rotation included). */
function contentExtent(document: CanvasDocument, nodeId: string | undefined): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of nodeId === undefined ? document.rootIds : [nodeId]) {
    const node = document.nodes[id];
    if (!node) continue;
    const radians = ((node.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(radians));
    const sin = Math.abs(Math.sin(radians));
    const halfWidth = (node.width * cos + node.height * sin) / 2;
    const halfHeight = (node.width * sin + node.height * cos) / 2;
    const centerX = node.x + node.width / 2;
    const centerY = node.y + node.height / 2;
    minX = Math.min(minX, centerX - halfWidth);
    minY = Math.min(minY, centerY - halfHeight);
    maxX = Math.max(maxX, centerX + halfWidth);
    maxY = Math.max(maxY, centerY + halfHeight);
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  return Number.isFinite(extent) ? extent : 0;
}

/** Serialize each document independently; discard its lock once every waiter finishes. */
function makeDocumentLock() {
  const locks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  return {
    withLock: <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          let lock = locks.get(id);
          if (!lock) {
            lock = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
            locks.set(id, lock);
          }
          lock.users++;
          return lock.semaphore;
        }),
        (semaphore) => semaphore.withPermit(effect),
        () =>
          Effect.sync(() => {
            const lock = locks.get(id)!;
            if (--lock.users === 0) locks.delete(id);
          }),
      ),
  };
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const hosts = yield* CanvasHostBroker.CanvasHostBroker;
  const scope = yield* Effect.scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let importBusy = false;
  const withImportSlot = <A, E, R>(fileName: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend<A, E | CanvasImportError, R>(() => {
      if (importBusy)
        return Effect.fail(
          new CanvasImportError({
            fileName,
            reason: "Another canvas is importing. Wait for it to finish and retry.",
          }),
        );
      importBusy = true;
      return effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            importBusy = false;
          }),
        ),
      );
    });

  const canvasRoot = path.join(config.stateDir, "canvas");
  const docLock = makeDocumentLock();
  const writeLock = makeDocumentLock();
  const entries = new Map<string, Entry>();
  let closed = false;
  const requireActive = Effect.suspend(() =>
    closed ? Effect.fail(canvasDisabledError()) : Effect.void,
  );
  /** documentId -> file path, filled on create and on lookup. */
  const locations = new Map<string, string>();

  const projectDir = (projectId: ProjectId) => {
    // Project ids may contain ':' (not portable in file names).
    const segment = encodeURIComponent(projectId);
    return path.join(canvasRoot, segment === "." || segment === ".." ? `_${segment}` : segment);
  };

  const storageError =
    (operation: CanvasStorageError["operation"], documentId?: string) => (cause: unknown) =>
      new CanvasStorageError({
        operation,
        ...(documentId === undefined ? {} : { documentId }),
        cause,
      });

  const requireProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(storageError("read")),
      Effect.flatMap((project) =>
        Effect.fromOption(project).pipe(
          Effect.mapError(() => new CanvasProjectNotFoundError({ projectId })),
        ),
      ),
    );

  const assetsDir = (filePath: string) => filePath.replace(/\.json$/, ".assets");
  const summaryPath = (filePath: string) => filePath.replace(/\.json$/, ".summary.json");

  /** Reads a document and its asset files; records the hashes so unchanged assets are never rewritten. */
  const readDocumentFile = Effect.fn("CanvasService.readDocumentFile")(
    function* (
      filePath: string,
      documentId: string,
      assetHashes = new WeakMap<CanvasAsset, string>(),
    ) {
      const { assetFiles, ...stored } = yield* decodeStoredDocumentJson(
        yield* fs.readFileString(filePath),
      );
      if (assetFiles === undefined) return stored;
      const entries = yield* Effect.forEach(
        Object.entries(assetFiles),
        ([id, hash]) =>
          Effect.gen(function* () {
            if (!ASSET_HASH.test(hash)) return yield* Effect.fail(`invalid asset hash for ${id}`);
            const asset = yield* decodeAssetJson(
              yield* fs.readFileString(path.join(assetsDir(filePath), `${hash}.json`)),
            );
            assetHashes.set(asset, hash);
            return [id, asset] as const;
          }),
        { concurrency: 8 },
      );
      const document: CanvasDocument = { ...stored, assets: Object.fromEntries(entries) };
      return document;
    },
    (effect, _filePath, documentId, _assetHashes?: WeakMap<CanvasAsset, string>) =>
      effect.pipe(Effect.mapError(storageError("read", documentId))),
  );

  /** Finds a document's file without loading it. */
  const locate = Effect.fn("CanvasService.locate")(function* (documentId: string) {
    const notFound = new CanvasDocumentNotFoundError({ documentId });
    if (!SAFE_DOCUMENT_ID.test(documentId)) return yield* notFound;
    const known = entries.get(documentId)?.path ?? locations.get(documentId);
    if (known !== undefined) return known;
    const projectDirs = yield* fs
      .readDirectory(canvasRoot)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const dir of projectDirs) {
      const candidate = path.join(canvasRoot, dir, `${documentId}.json`);
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        locations.set(documentId, candidate);
        return candidate;
      }
    }
    return yield* notFound;
  });

  const checkProject = (document: CanvasDocument, ref: DocumentRef) =>
    ref.projectId !== undefined && document.projectId !== ref.projectId
      ? Effect.fail(new CanvasDocumentNotFoundError({ documentId: ref.documentId }))
      : Effect.succeed(document);

  /** Loads a document into the cache. Call under `docLock`. */
  const load = Effect.fn("CanvasService.load")(function* (ref: DocumentRef) {
    yield* requireActive;
    const cached = entries.get(ref.documentId);
    if (cached) {
      yield* checkProject(cached.document, ref);
      return cached;
    }
    const filePath = yield* locate(ref.documentId);
    const assetHashes = new WeakMap<CanvasAsset, string>();
    const document = yield* readDocumentFile(filePath, ref.documentId, assetHashes);
    yield* checkProject(document, ref);
    yield* requireActive;
    const entry: Entry = {
      document,
      path: filePath,
      events: yield* PubSub.unbounded<CanvasDocumentEvent>(),
      persistedRevision: document.revision,
      subscribers: 0,
      flushScheduled: false,
      deleted: false,
      assetHashes,
    };
    entries.set(ref.documentId, entry);
    return entry;
  });

  const evictIfIdle = (entry: Entry) =>
    Effect.sync(() => {
      const id = entry.document.id;
      if (
        entries.get(id) === entry &&
        entry.subscribers === 0 &&
        !entry.flushScheduled &&
        entry.persistedRevision === entry.document.revision
      ) {
        entries.delete(id);
      }
    });

  const writeAtomically = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  /** Writes new asset files first, then the document and its summary. */
  const writeDocument = Effect.fn("CanvasService.writeDocument")(
    function* (
      filePath: string,
      documentId: string,
      serialized: ReturnType<typeof serializeDocument>,
      assetHashes: WeakMap<CanvasAsset, string>,
    ) {
      for (const { asset, hash, json } of serialized.newAssets) {
        const assetPath = path.join(assetsDir(filePath), `${hash}.json`);
        if (!(yield* fs.exists(assetPath))) yield* writeAtomically(assetPath, json);
        assetHashes.set(asset, hash);
      }
      yield* writeAtomically(filePath, serialized.documentJson);
      yield* writeAtomically(summaryPath(filePath), serialized.summaryJson);
    },
    (effect, _filePath, documentId) =>
      effect.pipe(Effect.mapError(storageError("write", documentId))),
  );

  /** Writes the entry's latest revision; serialized per document so writes land in order. */
  const flush = (entry: Entry) =>
    writeLock.withLock(
      entry.document.id,
      Effect.gen(function* () {
        const document = entry.document;
        if (entry.deleted || entry.persistedRevision === document.revision) return;
        const serialized = serializeDocument(document, entry.assetHashes);
        yield* writeDocument(entry.path, document.id, serialized, entry.assetHashes);
        entry.persistedRevision = document.revision;
      }),
    );

  const scheduleFlush = Effect.fn("CanvasService.scheduleFlush")(function* (entry: Entry) {
    if (closed || entry.flushScheduled) return;
    entry.flushScheduled = true;
    yield* Effect.sleep(CANVAS_PERSIST_INTERVAL).pipe(
      Effect.andThen(
        Effect.sync(() => {
          entry.flushScheduled = false;
        }),
      ),
      Effect.andThen(flush(entry)),
      Effect.catchCause((cause) => Effect.logError("canvas persist failed", { cause })),
      Effect.andThen(docLock.withLock(entry.document.id, evictIfIdle(entry))),
      Effect.forkIn(scope),
    );
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      for (const entry of Array.from(entries.values())) {
        // Finish an admitted edit before flushing; no later edit can enter this generation.
        yield* docLock.withLock(
          entry.document.id,
          flush(entry).pipe(
            Effect.catchCause((cause) => Effect.logError("canvas persist failed", { cause })),
            Effect.ensuring(PubSub.shutdown(entry.events)),
          ),
        );
      }
    }),
  );

  const list: CanvasService["Service"]["list"] = Effect.fn("CanvasService.list")(function* (input) {
    yield* requireProject(input.projectId);
    const dir = projectDir(input.projectId);
    const names = yield* fs.readDirectory(dir).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<ReadonlyArray<string>>([])
            : Effect.fail(storageError("list")(error)),
        onSuccess: (names) => Effect.succeed<ReadonlyArray<string>>(names),
      }),
    );
    const summaries: CanvasDocumentSummary[] = [];
    for (const name of names) {
      // `<id>.json` only; ids never contain dots, so summary sidecars are skipped here.
      if (!name.endsWith(".json")) continue;
      const documentId = name.slice(0, -".json".length);
      if (!SAFE_DOCUMENT_ID.test(documentId)) continue;
      const cached = entries.get(documentId);
      if (cached) {
        summaries.push(summarizeCanvasDocument(cached.document));
        continue;
      }
      const filePath = path.join(dir, name);
      locations.set(documentId, filePath);
      // The sidecar avoids decoding every node; documents written before it existed fall back.
      const summary = yield* fs.readFileString(summaryPath(filePath)).pipe(
        Effect.flatMap(decodeSummaryJson),
        Effect.catch(() =>
          readDocumentFile(filePath, documentId).pipe(Effect.map(summarizeCanvasDocument)),
        ),
        Effect.option,
      );
      if (Option.isSome(summary)) summaries.push(summary.value);
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  });

  const createDocument = Effect.fn("CanvasService.createDocument")(function* <E = never>(
    input: {
      readonly projectId: ProjectId;
      readonly name?: string | undefined;
      readonly import?:
        | { readonly fileName: string; readonly bytes: Uint8Array | string }
        | undefined;
    },
    authorize: Effect.Effect<void, E> = Effect.void,
  ) {
    yield* requireProject(input.projectId);
    const imported = input.import
      ? yield* importCanvasInProcess(input.import.fileName, input.import.bytes).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        )
      : undefined;
    if (imported && imported.rootIds.length === 0) {
      return yield* new CanvasImportError({
        fileName: input.import!.fileName,
        reason: imported.warnings[0] ?? "the file has no layers",
      });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const id = makeCanvasNodeId();
    const name = input.name?.trim() || imported?.name || "Untitled";
    const document: CanvasDocument = {
      version: CANVAS_DOCUMENT_VERSION,
      id,
      projectId: input.projectId,
      name,
      revision: 0,
      rootIds: imported?.rootIds ?? [],
      nodes: imported?.nodes ?? {},
      assets: imported?.assets ?? {},
      createdAt: now,
      updatedAt: now,
    };
    const filePath = path.join(projectDir(input.projectId), `${id}.json`);
    const assetHashes = new WeakMap<CanvasAsset, string>();
    const serialized = serializeDocument(document, assetHashes);
    // A caller can lose write access while the isolated importer runs.
    yield* authorize;
    yield* requireActive;
    // Imported nodes and assets were validated in the isolated process.
    yield* writeDocument(filePath, id, serialized, assetHashes);
    locations.set(id, filePath);
    return { document, warnings: imported?.warnings ?? [] };
  });

  const create: CanvasService["Service"]["create"] = (input, authorize = Effect.void) => {
    if (!input.import)
      return createDocument({ projectId: input.projectId, name: input.name }, authorize);
    const payload = input.import;
    return withImportSlot(
      payload.fileName,
      Effect.suspend(() => {
        if (payload.bytesBase64.length > Math.ceil(CANVAS_UPLOAD_MAX_BYTES / 3) * 4) {
          return Effect.fail(
            new CanvasImportError({
              fileName: payload.fileName,
              reason: `The upload is larger than ${CANVAS_UPLOAD_MAX_BYTES / (1024 * 1024)} MiB.`,
            }),
          );
        }
        return createDocument(
          {
            projectId: input.projectId,
            name: input.name,
            import: {
              fileName: payload.fileName,
              bytes: new Uint8Array(Buffer.from(payload.bytesBase64, "base64")),
            },
          },
          authorize,
        );
      }),
    );
  };

  const importUpload: CanvasService["Service"]["importUpload"] = (input) =>
    withImportSlot(
      input.fileName,
      Effect.scoped(
        Effect.gen(function* () {
          yield* requireProject(input.projectId);
          const filePath = yield* Effect.gen(function* () {
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-canvas-upload-" });
            const target = path.join(dir, "input");
            let received = 0;
            yield* Stream.run(
              input.body.pipe(
                Stream.mapError(
                  (cause) =>
                    new CanvasImportError({
                      fileName: input.fileName,
                      reason: "The upload was interrupted.",
                      cause,
                    }),
                ),
                Stream.mapEffect((chunk) => {
                  received += chunk.byteLength;
                  return received > CANVAS_UPLOAD_MAX_BYTES
                    ? Effect.fail(
                        new CanvasImportError({
                          fileName: input.fileName,
                          reason: `The upload is larger than ${CANVAS_UPLOAD_MAX_BYTES / (1024 * 1024)} MiB.`,
                        }),
                      )
                    : Effect.succeed(chunk);
                }),
              ),
              fs.sink(target),
            );
            return target;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new CanvasImportError({
                  fileName: input.fileName,
                  reason: "The upload was interrupted or exceeded the size limit.",
                  cause,
                }),
            ),
          );
          return yield* createDocument({
            projectId: input.projectId,
            name: input.name,
            import: { fileName: input.fileName, bytes: filePath },
          });
        }),
      ),
    );

  const createFromWorkspaceFile = Effect.fn("CanvasService.createFromWorkspaceFile")(function* <
    E = never,
  >(
    input: Parameters<CanvasService["Service"]["createFromWorkspaceFile"]>[0],
    authorize: Effect.Effect<void, E> = Effect.void,
  ) {
    const project = yield* requireProject(input.projectId);
    const root = input.workspaceRoot ?? project.workspaceRoot;
    const fileName = path.basename(input.relativePath);
    const outside = new CanvasImportError({
      fileName: input.relativePath,
      reason: "the path must be a file inside the workspace",
    });
    const target = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: root, relativePath: input.relativePath })
      .pipe(Effect.mapError(() => outside));
    // Resolve symlinks so a link inside the workspace cannot read outside it.
    const realRoot = yield* fs.realPath(root).pipe(Effect.mapError(() => outside));
    const realTarget = yield* fs.realPath(target.absolutePath).pipe(
      Effect.mapError(
        () =>
          new CanvasImportError({
            fileName: input.relativePath,
            reason: "the file was not found",
          }),
      ),
    );
    const relative = path.relative(realRoot, realTarget);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return yield* outside;
    const info = yield* fs.stat(realTarget).pipe(Effect.mapError(() => outside));
    if (info.type !== "File") return yield* outside;
    if (Number(info.size) > WORKSPACE_IMPORT_MAX_BYTES) {
      return yield* new CanvasImportError({
        fileName: input.relativePath,
        reason: "the file is larger than 256 MB",
      });
    }
    return yield* withImportSlot(
      fileName,
      Effect.gen(function* () {
        const bytes = yield* fs.readFile(realTarget).pipe(
          Effect.mapError(
            (cause) =>
              new CanvasImportError({
                fileName: input.relativePath,
                reason: "the file could not be read",
                cause,
              }),
          ),
        );
        return yield* createDocument(
          {
            projectId: input.projectId,
            name: input.name,
            import: { fileName, bytes },
          },
          authorize,
        );
      }),
    );
  });

  const get: CanvasService["Service"]["get"] = Effect.fn("CanvasService.get")(function* (ref) {
    const cached = entries.get(ref.documentId);
    if (cached) return yield* checkProject(cached.document, ref);
    const filePath = yield* locate(ref.documentId);
    const document = yield* readDocumentFile(filePath, ref.documentId);
    return yield* checkProject(document, ref);
  });

  const deleteDocument: CanvasService["Service"]["delete"] = (ref) =>
    docLock
      .withLock(
        ref.documentId,
        Effect.gen(function* () {
          const entry = yield* load(ref);
          yield* requireActive;
          entry.deleted = true;
          entries.delete(ref.documentId);
          locations.delete(ref.documentId);
          yield* writeLock.withLock(
            ref.documentId,
            Effect.gen(function* () {
              yield* fs.remove(entry.path);
              yield* fs.remove(summaryPath(entry.path)).pipe(Effect.ignore);
              yield* fs.remove(assetsDir(entry.path), { recursive: true }).pipe(Effect.ignore);
            }).pipe(Effect.mapError(storageError("delete", ref.documentId))),
          );
          yield* PubSub.publish(entry.events, { type: "deleted" });
        }),
      )
      .pipe(Effect.withSpan("CanvasService.delete"));

  const applyOps: CanvasService["Service"]["applyOps"] = (input, authorize = Effect.void) =>
    docLock
      .withLock(
        input.documentId,
        Effect.gen(function* () {
          const entry = yield* load(input);
          const current = entry.document;
          if (input.baseRevision !== undefined && input.baseRevision !== current.revision) {
            return yield* new CanvasRevisionConflictError({
              documentId: input.documentId,
              baseRevision: input.baseRevision,
              revision: current.revision,
            });
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const next = yield* Effect.try({
            try: () => applyCanvasOps(current, input.ops, now),
            catch: (cause) =>
              new CanvasOpRejectedError({
                documentId: input.documentId,
                reason: cause instanceof CanvasOpError ? cause.message : "the batch is invalid",
              }),
          });
          // Patches are untyped records; reject one that leaves a node malformed.
          for (const op of input.ops) {
            if (op.op !== "update") continue;
            const node = next.nodes[op.id];
            if (node && !isCanvasNode(node)) {
              return yield* new CanvasOpRejectedError({
                documentId: input.documentId,
                reason: `the update to ${op.id} leaves it with invalid fields`,
              });
            }
          }
          // Recheck after waiting for the document lock, before edits become visible.
          yield* authorize;
          yield* requireActive;
          entry.document = next;
          yield* PubSub.publish(entry.events, {
            type: "ops",
            revision: next.revision,
            ops: input.ops,
            ...(input.clientBatchId === undefined ? {} : { clientBatchId: input.clientBatchId }),
          });
          yield* scheduleFlush(entry);
          return { revision: next.revision };
        }),
      )
      .pipe(Effect.withSpan("CanvasService.applyOps"));

  const subscribe: CanvasService["Service"]["subscribe"] = (ref) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Snapshot and subscription are taken under the document lock, so no
        // batch can land between them.
        const { entry, snapshot, subscription } = yield* docLock.withLock(
          ref.documentId,
          Effect.gen(function* () {
            const entry = yield* load(ref);
            const subscription = yield* PubSub.subscribe(entry.events);
            entry.subscribers += 1;
            return { entry, snapshot: entry.document, subscription };
          }),
        );
        yield* Effect.addFinalizer(() =>
          docLock.withLock(
            ref.documentId,
            Effect.sync(() => {
              entry.subscribers -= 1;
            }).pipe(Effect.andThen(evictIfIdle(entry))),
          ),
        );
        const first: CanvasDocumentEvent = { type: "snapshot", document: snapshot };
        return Stream.concat(
          Stream.make(first),
          Stream.fromSubscription(subscription).pipe(
            Stream.takeUntil((event) => event.type === "deleted"),
          ),
        );
      }),
    );

  const screenshot: CanvasService["Service"]["screenshot"] = Effect.fn("CanvasService.screenshot")(
    function* (input) {
      const document = yield* get(input);
      if (input.nodeId !== undefined && !document.nodes[input.nodeId]) {
        return yield* new CanvasNodeNotFoundError({
          documentId: input.documentId,
          nodeId: input.nodeId,
        });
      }
      const requested = Math.min(4, Math.max(0.1, input.scale ?? 1));
      // Aim under the cap: shadows and overflowing children paint past the boxes measured here.
      const extent = contentExtent(document, input.nodeId) * 1.1;
      const scale = extent > 0 ? Math.min(requested, SCREENSHOT_MAX_SIDE / extent) : requested;
      const request = { documentId: input.documentId, nodeId: input.nodeId };
      const shot = yield* hosts.screenshot({ ...request, scale });
      const longest = Math.max(shot.width, shot.height);
      if (longest <= SCREENSHOT_MAX_SIDE) return shot;
      const retry = yield* hosts.screenshot({
        ...request,
        scale: (scale * (SCREENSHOT_MAX_SIDE - 1)) / longest,
      });
      if (Math.max(retry.width, retry.height) <= SCREENSHOT_MAX_SIDE) return retry;
      return yield* new CanvasHostRequestFailedError({
        requestType: "screenshot",
        reason: `the image is ${retry.width}x${retry.height}, over the ${SCREENSHOT_MAX_SIDE} px limit`,
      });
    },
  );

  const open: CanvasService["Service"]["open"] = Effect.fn("CanvasService.open")(function* (input) {
    if (input.documentId !== undefined) {
      yield* get({ documentId: input.documentId, projectId: input.projectId });
    }
    yield* hosts.open({ threadId: input.threadId, documentId: input.documentId });
  });

  const render: CanvasService["Service"]["render"] = Effect.fn("CanvasService.render")(
    function* (input) {
      const document = yield* get(input);
      const shot = yield* screenshot(input);
      // Canonical base64 keeps client-supplied bytes out of the HTML markup.
      const png = Buffer.from(shot.pngBase64, "base64").toString("base64");
      if (!png || shot.width < 1 || shot.height < 1) {
        return yield* new CanvasHostRequestFailedError({
          requestType: "screenshot",
          reason: "the client returned an empty image",
        });
      }
      yield* requireActive;
      const htmlRender = yield* HtmlRender.HtmlRender;
      const nodeName = input.nodeId ? document.nodes[input.nodeId]?.name : undefined;
      return yield* htmlRender
        .publish({
          threadId: input.threadId,
          title: input.title?.trim() || nodeName?.trim() || document.name,
          height: Math.ceil((HTML_RENDER_COLUMN_WIDTH * shot.height) / shot.width),
          html: `<!doctype html><html><head><style>html,body{background:transparent}img{display:block;width:100%;height:auto}</style></head><body><img alt="Canvas snapshot" width="${shot.width}" height="${shot.height}" src="data:image/png;base64,${png}"></body></html>`,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CanvasStorageError({ operation: "write", documentId: input.documentId, cause }),
          ),
        );
    },
  );

  return CanvasService.of({
    list,
    create,
    importUpload,
    createFromWorkspaceFile,
    get,
    delete: deleteDocument,
    applyOps,
    subscribe,
    screenshot,
    render,
    open,
  });
});

export const layer = Layer.effect(
  CanvasService,
  builtinService("t3.canvas", CanvasService.key, make, { lifecycle: true }),
);
