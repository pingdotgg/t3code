// @effect-diagnostics nodeBuiltinImport:off -- SHA-256 revisions use the host crypto implementation.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { parseDocument } from "yaml";
import {
  TASK_DOCUMENT_MAX_BYTES,
  TaskDocumentId,
  TaskDocumentRegistration,
  TaskDocumentRecovery,
  TaskDocumentError,
  TaskDocumentConflict,
  type TaskDocumentOperationError,
  type TaskDocumentSummary,
  type OpenTaskDocument,
  type TaskDocumentRef,
  type RegisterTaskDocumentInput,
  type SaveTaskDocumentInput,
  type RelinkTaskDocumentInput,
  type TaskDocumentRecoveryRef,
  type TaskDocumentNotice,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";

export class TaskDocuments extends Context.Service<
  TaskDocuments,
  {
    readonly register: (
      input: RegisterTaskDocumentInput,
    ) => Effect.Effect<OpenTaskDocument, TaskDocumentOperationError>;
    readonly open: (
      input: TaskDocumentRef,
    ) => Effect.Effect<OpenTaskDocument, TaskDocumentOperationError>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<TaskDocumentSummary>,
      TaskDocumentOperationError
    >;
    readonly save: (
      input: SaveTaskDocumentInput,
    ) => Effect.Effect<OpenTaskDocument, TaskDocumentOperationError>;
    readonly relink: (
      input: RelinkTaskDocumentInput,
    ) => Effect.Effect<OpenTaskDocument, TaskDocumentOperationError>;
    readonly unregister: (
      input: TaskDocumentRef,
    ) => Effect.Effect<void, TaskDocumentOperationError>;
    readonly listRecovery: (
      input: TaskDocumentRef,
    ) => Effect.Effect<ReadonlyArray<TaskDocumentRecoveryRef>, TaskDocumentOperationError>;
    readonly readRecovery: (
      input: TaskDocumentRecoveryRef,
    ) => Effect.Effect<TaskDocumentRecovery, TaskDocumentOperationError>;
    readonly subscribeCatalogue: () => Stream.Stream<TaskDocumentNotice>;
    readonly subscribeDocument: (
      input: TaskDocumentRef,
    ) => Stream.Stream<OpenTaskDocument, TaskDocumentOperationError>;
  }
>()("t3/tasks/TaskDocuments") {}

type DirectoryObservation = {
  running: boolean;
  ready: boolean;
  fiber: Fiber.Fiber<void, PlatformError.PlatformError | TaskDocumentError> | undefined;
};

const MAX_REGISTRATIONS = 64;
const MAX_RECOVERY_BYTES = 32 * 1024 * 1024;
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const encode = (text: string) => new TextEncoder().encode(text);
const decodeUuid = Schema.decodeUnknownOption(Schema.String.check(Schema.isUUID()));
const decodeRegistration = Schema.decodeUnknownEffect(TaskDocumentRegistration);
const decodeRecovery = Schema.decodeUnknownEffect(Schema.fromJsonString(TaskDocumentRecovery));
const encodeRecovery = Schema.encodeEffect(Schema.fromJsonString(TaskDocumentRecovery));

function metadata(contents: string) {
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)?.[1];
  const document = parseDocument(frontmatter ?? "", { uniqueKeys: true });
  const get = (key: string): unknown =>
    document.errors.length === 0 ? document.get(key) : undefined;
  const id = decodeUuid(get("id"));
  const title = get("title");
  const state = get("state");
  return {
    fileId: Option.isSome(id) ? id.value.toLowerCase() : null,
    title: typeof title === "string" ? title.slice(0, 512) : "",
    state: typeof state === "string" ? state.slice(0, 512) : null,
    pinned: get("pinned") === true,
  };
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const recoveryRoot = path.join(config.stateDir, "task-document-recovery");
  // ponytail: one lock serializes registry changes and saves; use per-target locks if save throughput warrants it.
  const lock = yield* Semaphore.make(1);
  const recoveryLock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<TaskDocumentNotice>(1);
  const scope = yield* Effect.scope;
  const watchers = new Map<string, DirectoryObservation>();
  const unavailableDirectories = new Set<string>();
  const generations = new Map<TaskDocumentId, number>();
  const canCache = (target: string) =>
    watchers.get(path.dirname(target))?.ready === true &&
    !unavailableDirectories.has(path.dirname(target));
  const summaries = new Map<TaskDocumentId, TaskDocumentSummary>();
  const encountered = new Map<TaskDocumentId, string>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

  const ioError = (cause?: unknown) => new TaskDocumentError({ reason: "io", cause });
  const mapIo = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.mapError(ioError));
  const rows = Effect.fn("TaskDocuments.registrations")(function* () {
    const result =
      yield* mapIo(sql`SELECT task_document_id AS taskDocumentId, canonical_path AS canonicalPath,
      locator_version AS locatorVersion, file_id AS observedFileId, registered FROM task_documents`);
    return yield* Effect.forEach(result, (row) =>
      decodeRegistration({ ...row, registered: row.registered === 1 }).pipe(
        Effect.mapError(ioError),
      ),
    );
  });
  const registration = Effect.fn("TaskDocuments.registration")(function* (
    input: TaskDocumentRef,
    allowUnregistered = false,
  ) {
    const found = (yield* rows()).find((row) => row.taskDocumentId === input.taskDocumentId);
    if (!found || (!found.registered && !allowUnregistered))
      return yield* new TaskDocumentError({ reason: "not-registered" });
    return found;
  });

  const read = Effect.fn("TaskDocuments.read")(
    function* (target: string) {
      const canonicalPath = yield* fs.realPath(target);
      const before = yield* fs.stat(canonicalPath);
      if (before.type !== "File") return yield* new TaskDocumentError({ reason: "unsupported" });
      const handle = yield* fs.open(canonicalPath, { flag: "r" });
      const info = yield* handle.stat;
      if (info.type !== "File" || !/\.md$/i.test(canonicalPath))
        return yield* new TaskDocumentError({ reason: "unsupported" });
      if (Number(info.size) > TASK_DOCUMENT_MAX_BYTES)
        return yield* new TaskDocumentError({ reason: "too-large" });
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = yield* handle.readAlloc(
          Math.min(64 * 1024, TASK_DOCUMENT_MAX_BYTES + 1 - length),
        );
        if (Option.isNone(chunk)) break;
        length += chunk.value.length;
        if (length > TASK_DOCUMENT_MAX_BYTES)
          return yield* new TaskDocumentError({ reason: "too-large" });
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const contents = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
        catch: () => new TaskDocumentError({ reason: "unsupported" }),
      });
      if (contents.includes("\0")) return yield* new TaskDocumentError({ reason: "unsupported" });
      return { canonicalPath, contents, revision: hash(bytes), info, metadata: metadata(contents) };
    },
    Effect.scoped,
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.fail(
          new TaskDocumentError({ reason: cause.reason._tag === "NotFound" ? "missing" : "io" }),
        ),
    }),
  );

  const opened = (
    row: TaskDocumentRegistration,
    file: Effect.Success<ReturnType<typeof read>>,
  ): OpenTaskDocument => ({
    contents: file.contents,
    revision: file.revision,
    summary: {
      ...row,
      title:
        file.metadata.title || path.basename(row.canonicalPath, path.extname(row.canonicalPath)),
      state: file.metadata.state,
      pinned: file.metadata.pinned,
      availability: file.metadata.fileId === row.observedFileId ? "available" : "identity-changed",
      revision: file.revision,
    },
  });
  const open = Effect.fn("TaskDocuments.open")(function* (input: TaskDocumentRef) {
    const generation = generations.get(input.taskDocumentId);
    const row = yield* registration(input);
    const file = yield* read(row.canonicalPath);
    if (file.canonicalPath !== row.canonicalPath)
      return yield* new TaskDocumentError({ reason: "stale-locator" });
    const result = opened(row, file);
    if (encountered.get(row.taskDocumentId) !== file.revision) {
      yield* retain({
        taskDocumentId: row.taskDocumentId,
        recoveryId: NodeCrypto.randomUUID(),
        expectedRevision: file.revision,
        locatorVersion: row.locatorVersion,
        baseContents: file.contents,
        contents: file.contents,
        disk: null,
      });
      encountered.set(row.taskDocumentId, file.revision);
    }
    if (generations.get(row.taskDocumentId) === generation && canCache(row.canonicalPath)) {
      summaries.set(row.taskDocumentId, result.summary);
    }
    return result;
  });
  const summary = Effect.fn("TaskDocuments.summary")(function* (row: TaskDocumentRegistration) {
    if (row.registered) {
      const result = yield* open(row).pipe(Effect.result);
      if (result._tag === "Success") return result.success.summary;
      return {
        ...row,
        title: path.basename(row.canonicalPath),
        state: null,
        pinned: false,
        availability:
          result.failure._tag === "TaskDocumentError" && result.failure.reason === "missing"
            ? "missing"
            : "unavailable",
        revision: null,
      } satisfies TaskDocumentSummary;
    }
    return {
      ...row,
      title: path.basename(row.canonicalPath),
      state: null,
      pinned: false,
      availability: "unregistered",
      revision: null,
    } satisfies TaskDocumentSummary;
  });
  const list = Effect.fn("TaskDocuments.list")(function* () {
    return yield* Effect.forEach(yield* rows(), (row) =>
      row.registered &&
      canCache(row.canonicalPath) &&
      summaries.get(row.taskDocumentId)?.locatorVersion === row.locatorVersion
        ? Effect.succeed(summaries.get(row.taskDocumentId)!)
        : summary(row),
    );
  });
  const notify = Effect.fn("TaskDocuments.notify")(function* (taskDocumentId: TaskDocumentId) {
    generations.set(taskDocumentId, (generations.get(taskDocumentId) ?? 0) + 1);
    summaries.delete(taskDocumentId);
    yield* PubSub.publish(changes, { taskDocumentId });
  });
  const unique = Effect.fn("TaskDocuments.unique")(function* (
    file: Effect.Success<ReturnType<typeof read>>,
    except?: TaskDocumentId,
  ) {
    const all = yield* rows();
    for (const row of all) {
      if (row.taskDocumentId === except) continue;
      if (row.canonicalPath === file.canonicalPath)
        return yield* new TaskDocumentError({ reason: "duplicate-path" });
      const other = yield* fs.stat(row.canonicalPath).pipe(Effect.option);
      if (
        Option.isSome(other) &&
        Option.isSome(other.value.ino) &&
        Option.isSome(file.info.ino) &&
        other.value.dev === file.info.dev &&
        other.value.ino.value === file.info.ino.value
      ) {
        return yield* new TaskDocumentError({ reason: "duplicate-path" });
      }
      if (
        file.metadata.fileId !== null &&
        (row.observedFileId === file.metadata.fileId || row.taskDocumentId === file.metadata.fileId)
      )
        return yield* new TaskDocumentError({ reason: "duplicate-id" });
    }
  });
  const register = Effect.fn("TaskDocuments.register")(function* (
    input: RegisterTaskDocumentInput,
  ) {
    if (!path.isAbsolute(input.path))
      return yield* new TaskDocumentError({ reason: "unsupported" });
    const file = yield* read(input.path);
    const all = yield* rows();
    const inactive = all.find((row) => !row.registered && row.canonicalPath === file.canonicalPath);
    yield* unique(file, inactive?.taskDocumentId);
    if (!inactive && all.length >= MAX_REGISTRATIONS)
      return yield* new TaskDocumentError({ reason: "limit" });
    const id =
      inactive?.taskDocumentId ??
      TaskDocumentId.make(file.metadata.fileId ?? NodeCrypto.randomUUID());
    if (inactive) {
      yield* mapIo(
        sql`UPDATE task_documents SET registered = 1, locator_version = locator_version + 1 WHERE task_document_id = ${id}`,
      );
    } else {
      yield* mapIo(
        sql`INSERT INTO task_documents (task_document_id, canonical_path, file_id) VALUES (${id}, ${file.canonicalPath}, ${file.metadata.fileId})`,
      );
    }
    yield* notify(id);
    yield* syncWatches();
    return yield* open({ taskDocumentId: id });
  }, lock.withPermit);

  const recoveryPath = (input: TaskDocumentRecoveryRef) =>
    path.join(recoveryRoot, `${input.taskDocumentId}.${input.recoveryId}.json`);
  const retain = Effect.fn("TaskDocuments.retain")(function* (recovery: TaskDocumentRecovery) {
    yield* mapIo(fs.makeDirectory(recoveryRoot, { recursive: true, mode: 0o700 }));
    const text = yield* encodeRecovery(recovery).pipe(Effect.mapError(ioError));
    const target = recoveryPath(recovery);
    const staging = `${target}.tmp`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => fs.remove(staging).pipe(Effect.ignore));
        yield* mapIo(fs.writeFileString(staging, text, { mode: 0o600 }));
        yield* mapIo(fs.rename(staging, target));
      }),
    );
    const names = (yield* mapIo(fs.readDirectory(recoveryRoot))).filter((name) =>
      name.endsWith(".json"),
    );
    const files = yield* Effect.forEach(names, (name) =>
      mapIo(fs.stat(path.join(recoveryRoot, name))).pipe(
        Effect.map((info) => ({
          name,
          size: Number(info.size),
          mtime: Option.getOrUndefined(info.mtime)?.getTime() ?? 0,
        })),
      ),
    );
    const currentName = path.basename(target);
    files.sort((a, b) =>
      a.name === currentName
        ? -1
        : b.name === currentName
          ? 1
          : b.mtime - a.mtime || a.name.localeCompare(b.name),
    );
    let bytes = 0;
    let ownCount = 0;
    for (const file of files) {
      bytes += file.size;
      const own = file.name.startsWith(`${recovery.taskDocumentId}.`);
      if (own) ownCount++;
      if (
        file.name !== path.basename(target) &&
        (bytes > MAX_RECOVERY_BYTES || (own && ownCount > 8))
      )
        yield* mapIo(fs.remove(path.join(recoveryRoot, file.name)));
    }
  }, recoveryLock.withPermit);
  const save = Effect.fn("TaskDocuments.save")(function* (input: SaveTaskDocumentInput) {
    const row = yield* registration(input);
    if (
      encode(input.contents).length > TASK_DOCUMENT_MAX_BYTES ||
      encode(input.baseContents).length > TASK_DOCUMENT_MAX_BYTES
    )
      return yield* new TaskDocumentError({ reason: "too-large" });
    if (
      input.contents.includes("\0") ||
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(encode(input.contents)) !==
        input.contents
    )
      return yield* new TaskDocumentError({ reason: "unsupported" });
    if (hash(encode(input.baseContents)) !== input.expectedRevision)
      return yield* new TaskDocumentError({ reason: "invalid-base" });
    const recovery: TaskDocumentRecovery = {
      ...input,
      recoveryId: NodeCrypto.randomUUID(),
      disk: null,
    };
    yield* retain(recovery);
    return yield* Effect.gen(function* () {
      if (row.locatorVersion !== input.locatorVersion)
        return yield* new TaskDocumentError({ reason: "stale-locator" });
      const disk = yield* open(input);
      yield* retain({ ...recovery, disk });
      if (disk.summary.availability === "identity-changed")
        return yield* new TaskDocumentError({ reason: "identity-changed" });
      if (disk.revision !== input.expectedRevision)
        return yield* new TaskDocumentConflict({ ...recovery, currentRevision: disk.revision });
      if (metadata(input.contents).fileId !== row.observedFileId)
        return yield* new TaskDocumentError({ reason: "identity-changed" });
      const file = yield* read(row.canonicalPath);
      if (Option.isSome(file.info.nlink) && file.info.nlink.value > 1n)
        return yield* new TaskDocumentError({ reason: "unsupported" });
      const staging = path.join(
        path.dirname(row.canonicalPath),
        `.t3-task-${NodeCrypto.randomUUID()}.tmp`,
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => fs.remove(staging).pipe(Effect.ignore));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* fs.open(staging, { flag: "wx", mode: file.info.mode & 0o777 });
              yield* handle.writeAll(encode(input.contents));
              yield* handle.sync;
            }),
          );
          yield* fs.chmod(staging, file.info.mode & 0o777);
          const current = yield* open(input);
          if (current.revision !== input.expectedRevision) {
            yield* retain({ ...recovery, disk: current });
            return yield* new TaskDocumentConflict({
              ...recovery,
              currentRevision: current.revision,
            });
          }
          // Hash validation cannot exclude a noncooperative writer between this check and replacement.
          yield* fs.rename(staging, row.canonicalPath);
        }),
      ).pipe(Effect.catchTags({ PlatformError: (cause) => Effect.fail(ioError(cause)) }));
      yield* notify(row.taskDocumentId);
      return yield* open(row);
    }).pipe(
      Effect.catchTags({
        TaskDocumentError: (error) =>
          Effect.fail(
            new TaskDocumentError({
              reason: error.reason,
              cause: error.cause,
              recovery: { taskDocumentId: row.taskDocumentId, recoveryId: recovery.recoveryId },
            }),
          ),
      }),
    );
  }, lock.withPermit);

  const relink = Effect.fn("TaskDocuments.relink")(function* (input: RelinkTaskDocumentInput) {
    const row = yield* registration(input);
    if (row.locatorVersion !== input.locatorVersion)
      return yield* new TaskDocumentError({ reason: "stale-locator" });
    if (!path.isAbsolute(input.path))
      return yield* new TaskDocumentError({ reason: "unsupported" });
    const file = yield* read(input.path);
    yield* unique(file, row.taskDocumentId);
    if (file.metadata.fileId !== row.observedFileId)
      return yield* new TaskDocumentError({ reason: "identity-changed" });
    yield* mapIo(
      sql`UPDATE task_documents SET canonical_path = ${file.canonicalPath}, locator_version = locator_version + 1 WHERE task_document_id = ${row.taskDocumentId}`,
    );
    yield* notify(row.taskDocumentId);
    yield* syncWatches();
    return yield* open(row);
  }, lock.withPermit);
  const unregister = Effect.fn("TaskDocuments.unregister")(function* (input: TaskDocumentRef) {
    yield* registration(input);
    yield* mapIo(
      sql`UPDATE task_documents SET registered = 0, locator_version = locator_version + 1 WHERE task_document_id = ${input.taskDocumentId}`,
    );
    yield* notify(input.taskDocumentId);
    yield* syncWatches();
  }, lock.withPermit);
  const listRecovery = Effect.fn("TaskDocuments.listRecovery")(function* (input: TaskDocumentRef) {
    yield* registration(input, true);
    const names = yield* fs.readDirectory(recoveryRoot).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(ioError()),
      }),
    );
    return names
      .filter((name) => name.startsWith(`${input.taskDocumentId}.`) && name.endsWith(".json"))
      .map((name) => ({
        taskDocumentId: input.taskDocumentId,
        recoveryId: name.slice(input.taskDocumentId.length + 1, -5),
      }));
  });
  const readRecovery = Effect.fn("TaskDocuments.readRecovery")(function* (
    input: TaskDocumentRecoveryRef,
  ) {
    yield* registration(input, true);
    const text = yield* fs
      .readFileString(recoveryPath(input))
      .pipe(Effect.mapError(() => new TaskDocumentError({ reason: "recovery-unavailable" })));
    return yield* decodeRecovery(text).pipe(Effect.mapError(ioError));
  });

  const markUnavailable = Effect.fn("TaskDocuments.markUnavailable")(function* (directory: string) {
    if (unavailableDirectories.has(directory)) return;
    unavailableDirectories.add(directory);
    yield* Effect.forEach(
      (yield* rows()).filter(
        (row) => row.registered && path.dirname(row.canonicalPath) === directory,
      ),
      (row) => notify(row.taskDocumentId),
      { discard: true },
    );
  });
  const syncWatches = Effect.fn("TaskDocuments.syncWatches")(function* () {
    const active = (yield* rows()).filter((row) => row.registered);
    const directories = new Set(active.map((row) => path.dirname(row.canonicalPath)));
    for (const [directory, observation] of watchers) {
      if (!directories.has(directory)) {
        if (observation.fiber) yield* Fiber.interrupt(observation.fiber);
        watchers.delete(directory);
        unavailableDirectories.delete(directory);
      }
    }
    for (const directory of directories) {
      const previous = watchers.get(directory);
      if (previous?.running && !unavailableDirectories.has(directory)) continue;
      if (previous?.fiber) yield* Fiber.interrupt(previous.fiber);
      const observation: DirectoryObservation = { running: true, ready: false, fiber: undefined };
      watchers.set(directory, observation);
      observation.fiber = yield* Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        yield* Effect.all(
          [
            fs
              .watch(directory, {
                onReady: () => {
                  Deferred.doneUnsafe(ready, Effect.void);
                },
              })
              .pipe(
                Stream.runForEach((event) =>
                  rows().pipe(
                    Effect.flatMap((current) =>
                      Effect.forEach(
                        current.filter(
                          (row) =>
                            row.registered &&
                            path.dirname(row.canonicalPath) === directory &&
                            (row.canonicalPath === event.path ||
                              path.basename(row.canonicalPath) === event.path ||
                              event.path === directory),
                        ),
                        (row) => notify(row.taskDocumentId),
                        { discard: true },
                      ),
                    ),
                  ),
                ),
                Effect.andThen(Effect.fail(new TaskDocumentError({ reason: "io" }))),
              ),
            Deferred.await(ready).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  observation.ready = true;
                  unavailableDirectories.delete(directory);
                  yield* Effect.forEach(
                    (yield* rows()).filter(
                      (row) => row.registered && path.dirname(row.canonicalPath) === directory,
                    ),
                    (row) => notify(row.taskDocumentId),
                    { discard: true },
                  );
                }),
              ),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(
        Effect.tapError(() => {
          observation.ready = false;
          return markUnavailable(directory);
        }),
        Effect.retry(Schedule.spaced("2 seconds")),
        Effect.ensuring(
          Effect.gen(function* () {
            observation.running = false;
            observation.ready = false;
            yield* markUnavailable(directory).pipe(Effect.ignore);
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      );
    }
  });
  yield* syncWatches();
  const subscribeDocument = (input: TaskDocumentRef) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(open(input)),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => open(input))),
        ).pipe(
          Stream.changesWith(
            (a, b) =>
              a.revision === b.revision && a.summary.locatorVersion === b.summary.locatorVersion,
          ),
        );
      }),
    );
  return TaskDocuments.of({
    register,
    open,
    list,
    save,
    relink,
    unregister,
    listRecovery,
    readRecovery,
    subscribeCatalogue: () => Stream.fromPubSub(changes),
    subscribeDocument,
  });
});

export const layer = Layer.effect(TaskDocuments, make);
