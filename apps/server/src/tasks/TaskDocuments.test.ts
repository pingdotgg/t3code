// @effect-diagnostics nodeBuiltinImport:off -- Directory junction fixtures work on Windows without symlink privileges.
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as PlatformError from "effect/PlatformError";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Fiber from "effect/Fiber";
import { TASK_DOCUMENT_MAX_BYTES, TaskDocumentId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as TaskDocuments from "./TaskDocuments.ts";

const layer = TaskDocuments.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-documents-" }),
  ),
  Layer.provide(Layer.succeed(HostProcess.Platform, HostProcess.Platform.defaultValue())),
  Layer.provideMerge(NodeServices.layer),
);
const fileId = "21dcf74b-fcf1-4464-afb5-b34392005d94";
const fixture = `\uFEFF---\r\nid: ${fileId}\r\ntitle: "Café task"\r\nstate: "Waiting on moon"\r\npinned: true\r\nunknown: [one, two] # keep this\r\n---\r\n# Task 雪\r\n`;
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-task-fixtures-" });
  const target = path.join(directory, "Café 雪.md");
  yield* fs.writeFileString(target, fixture);
  return { fs, path, directory, target, service: yield* TaskDocuments.TaskDocuments };
});
const save = (opened: import("@t3tools/contracts").OpenTaskDocument, contents: string) => ({
  taskDocumentId: opened.summary.taskDocumentId,
  locatorVersion: opened.summary.locatorVersion,
  expectedRevision: opened.revision,
  baseContents: opened.contents,
  contents,
});

describe("TaskDocuments", () => {
  it.effect("does not cache an open that completes after unregister", () =>
    Effect.gen(function* () {
      const { service, fs, target } = yield* setup;
      const original = yield* service.register({ path: target });
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      let paused = false;
      const racingFs = FileSystem.FileSystem.of({
        ...fs,
        open: (file, options) =>
          fs.open(file, options).pipe(
            Effect.map(
              (handle) =>
                new Proxy(handle, {
                  get: (fileHandle, key) =>
                    key === "readAlloc" && file === target
                      ? (...args: Parameters<typeof handle.readAlloc>) =>
                          Effect.gen(function* () {
                            if (paused) {
                              paused = false;
                              yield* Deferred.succeed(entered, undefined);
                              yield* Deferred.await(released);
                            }
                            return yield* fileHandle.readAlloc(...args);
                          })
                      : Reflect.get(fileHandle, key),
                }),
            ),
          ),
      });
      const racing = Context.get(
        yield* Layer.build(
          Layer.fresh(
            TaskDocuments.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, racingFs))),
          ),
        ),
        TaskDocuments.TaskDocuments,
      );
      paused = true;
      const opening = yield* racing.open(original.summary).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* racing.unregister(original.summary);
      yield* Deferred.succeed(released, undefined);
      yield* Fiber.join(opening);
      expect((yield* racing.list())[0]).toMatchObject({
        registered: false,
        availability: "unregistered",
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("bypasses stale summaries after watch failure and restores observation", () =>
    Effect.gen(function* () {
      const { service, fs, target, directory } = yield* setup;
      const original = yield* service.register({ path: target });
      const fail = yield* Deferred.make<void>();
      const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const started = yield* Queue.unbounded<number>();
      let attempts = 0;
      const watchingFs = FileSystem.FileSystem.of({
        ...fs,
        watch: (_directory, options) =>
          Stream.unwrap(
            Effect.gen(function* () {
              attempts++;
              options?.onReady?.();
              yield* Queue.offer(started, attempts);
              return attempts === 1
                ? Stream.fromEffect(Deferred.await(fail)).pipe(
                    Stream.flatMap(() =>
                      Stream.fail(
                        PlatformError.systemError({
                          _tag: "Unknown",
                          module: "FileSystem",
                          method: "watch",
                          pathOrDescriptor: directory,
                        }),
                      ),
                    ),
                  )
                : Stream.fromQueue(events);
            }),
          ),
      });
      const watching = Context.get(
        yield* Layer.build(
          Layer.fresh(
            TaskDocuments.layer.pipe(
              Layer.provide(Layer.succeed(FileSystem.FileSystem, watchingFs)),
            ),
          ),
        ),
        TaskDocuments.TaskDocuments,
      );
      expect(yield* Queue.take(started)).toBe(1);
      yield* watching.open(original.summary);
      const notices = yield* Queue.unbounded<import("@t3tools/contracts").TaskDocumentNotice>();
      yield* watching.subscribeCatalogue().pipe(
        Stream.runForEach((notice) => Queue.offer(notices, notice)),
        Effect.forkScoped({ startImmediately: true }),
      );
      const documents = yield* Queue.unbounded<import("@t3tools/contracts").OpenTaskDocument>();
      yield* watching.subscribeDocument(original.summary).pipe(
        Stream.filter((document) => document.contents === fixture + "second external change"),
        Stream.runForEach((document) => Queue.offer(documents, document)),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Deferred.succeed(fail, undefined);
      yield* Queue.take(notices);
      yield* fs.writeFileString(target, fixture + "first external change");
      const first = (yield* watching.list())[0]!;
      yield* fs.writeFileString(target, fixture + "second external change");
      expect((yield* watching.list())[0]?.revision).not.toBe(first.revision);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Queue.take(started)).toBe(2);
      yield* watching.list();
      expect(yield* Queue.size(notices)).toBeGreaterThan(0);
      yield* Queue.take(notices);
      expect((yield* Queue.take(documents)).contents).toBe(fixture + "second external change");
      expect(yield* Queue.size(events)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "preserves raw UTF-8/BOM/CRLF, projects metadata, and rejects stale saves with durable recovery",
    () =>
      Effect.gen(function* () {
        const { fs, target, service } = yield* setup;
        const opened = yield* service.register({ path: target });
        expect(opened.contents).toBe(fixture);
        expect(opened.summary).toMatchObject({
          taskDocumentId: fileId,
          state: "Waiting on moon",
          pinned: true,
        });
        const external = fixture + "External writer\r\n";
        yield* fs.writeFileString(target, external);
        const conflict = yield* service.save(save(opened, fixture + "Draft\r\n")).pipe(Effect.flip);
        expect(conflict._tag).toBe("TaskDocumentConflict");
        if (conflict._tag !== "TaskDocumentConflict") return;
        const recovery = yield* service.readRecovery(conflict);
        expect(recovery.baseContents).toBe(fixture);
        expect(recovery.contents).toBe(fixture + "Draft\r\n");
        expect(recovery.disk?.contents).toBe(external);
        expect(new Uint8Array(yield* fs.readFile(target))).toEqual(
          new TextEncoder().encode(external),
        );
        const current = yield* service.open(opened.summary);
        const updated = yield* service.save(save(current, external + "Saved\r\n"));
        expect(updated.revision).not.toBe(current.revision);
        expect(new Uint8Array(yield* fs.readFile(target))).toEqual(
          new TextEncoder().encode(updated.contents),
        );
        const restarted = Context.get(
          yield* Layer.build(Layer.fresh(TaskDocuments.layer)),
          TaskDocuments.TaskDocuments,
        );
        expect((yield* restarted.open(opened.summary)).revision).toBe(updated.revision);
        expect((yield* restarted.readRecovery(conflict)).contents).toBe(fixture + "Draft\r\n");
        for (let attempt = 0; attempt < 10; attempt++) {
          yield* restarted.save(save(opened, fixture + `draft ${attempt}`)).pipe(Effect.flip);
        }
        expect(yield* restarted.listRecovery(opened.summary)).toHaveLength(8);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "registers ID-less files without mutation, rejects duplicate identities, and retains manual ID changes",
    () =>
      Effect.gen(function* () {
        const { fs, path, directory, target, service } = yield* setup;
        const original = yield* service.register({ path: target });
        const duplicate = path.join(directory, "duplicate.md");
        yield* fs.writeFileString(duplicate, fixture);
        expect(yield* service.register({ path: duplicate }).pipe(Effect.flip)).toMatchObject({
          reason: "duplicate-id",
        });
        expect(
          yield* service
            .register({ path: path.join(directory, ".", "Café 雪.md") })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "duplicate-path" });
        const junction = path.join(directory, "junction");
        yield* Effect.promise(() => NodeFSP.symlink(directory, junction, "junction"));
        expect(
          yield* service
            .register({ path: path.join(junction, path.basename(target)) })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "duplicate-path" });
        const idless = path.join(directory, "legacy.md");
        yield* fs.writeFileString(idless, "---\nstate: arbitrary\nunknown: yes\n---\nLegacy\n");
        const legacy = yield* service.register({ path: idless });
        expect(legacy.summary.observedFileId).toBeNull();
        expect(yield* fs.readFileString(idless)).toBe(legacy.contents);
        yield* fs.writeFileString(
          target,
          fixture.replace(fileId, "a78f513d-0b95-4b31-8ac8-5a9063897dda"),
        );
        const changed = yield* service.open(original.summary);
        expect(changed.summary.taskDocumentId).toBe(original.summary.taskDocumentId);
        expect(changed.summary.availability).toBe("identity-changed");
        expect(
          yield* service.save(save(changed, changed.contents)).pipe(Effect.flip),
        ).toMatchObject({ reason: "identity-changed" });
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "relinks a missing file without recreating its old locator, and unregisters without deletion",
    () =>
      Effect.gen(function* () {
        const { fs, path, directory, target, service } = yield* setup;
        const original = yield* service.register({ path: target });
        const moved = path.join(directory, "moved.md");
        yield* fs.rename(target, moved);
        expect(yield* service.open(original.summary).pipe(Effect.flip)).toMatchObject({
          reason: "missing",
        });
        const relinked = yield* service.relink({ ...original.summary, path: moved });
        expect(relinked.summary.locatorVersion).toBe(original.summary.locatorVersion + 1);
        expect(
          yield* service.save(save(original, fixture + "late")).pipe(Effect.flip),
        ).toMatchObject({ reason: "stale-locator" });
        expect(yield* fs.exists(target)).toBe(false);
        yield* service.unregister(relinked.summary);
        expect(new Uint8Array(yield* fs.readFile(moved))).toEqual(
          new TextEncoder().encode(fixture),
        );
        expect(yield* service.open(relinked.summary).pipe(Effect.flip)).toMatchObject({
          reason: "not-registered",
        });
        expect(
          yield* service
            .open({ taskDocumentId: TaskDocumentId.make("f5f7c768-e6bb-4627-b38f-9e0e3544344b") })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "not-registered" });
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("serializes competing saves so exactly one writer advances a shared base", () =>
    Effect.gen(function* () {
      const { service, target } = yield* setup;
      const opened = yield* service.register({ path: target });
      const results = yield* Effect.all(
        [
          service.save(save(opened, fixture + "first")).pipe(Effect.result),
          service.save(save(opened, fixture + "second")).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "detects inode aliases and preserves hardlinked files instead of breaking the link",
    () =>
      Effect.gen(function* () {
        const { service, fs, path, directory, target } = yield* setup;
        const alias = path.join(directory, "alias.md");
        yield* fs.link(target, alias);
        const opened = yield* service.register({ path: target });
        expect(yield* service.register({ path: alias }).pipe(Effect.flip)).toMatchObject({
          reason: "duplicate-path",
        });
        expect(
          yield* service.save(save(opened, fixture + "draft")).pipe(Effect.flip),
        ).toMatchObject({ reason: "unsupported" });
        expect(new Uint8Array(yield* fs.readFile(alias))).toEqual(
          new TextEncoder().encode(fixture),
        );
        if ((yield* HostProcess.Platform) === "win32") {
          expect(
            yield* service.register({ path: target.toUpperCase() }).pipe(Effect.flip),
          ).toMatchObject({ reason: "duplicate-path" });
        }
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "rechecks an external writer after staging and retains a draft when replacement fails",
    () =>
      Effect.gen(function* () {
        const { service, fs, target, directory, path } = yield* setup;
        const opened = yield* service.register({ path: target });
        const external = fixture + "second writer\r\n";
        const racingFs = FileSystem.FileSystem.of({
          ...fs,
          open: (file, options) =>
            fs.open(file, options).pipe(
              Effect.map((handle) =>
                file.endsWith(".tmp") && options?.flag === "wx"
                  ? new Proxy(handle, {
                      get: (fileHandle, key) =>
                        key === "sync"
                          ? fileHandle.sync.pipe(
                              Effect.andThen(fs.writeFileString(target, external)),
                            )
                          : Reflect.get(fileHandle, key),
                    })
                  : handle,
              ),
            ),
        });
        const racing = Context.get(
          yield* Layer.build(
            Layer.fresh(
              TaskDocuments.layer.pipe(
                Layer.provide(Layer.succeed(FileSystem.FileSystem, racingFs)),
              ),
            ),
          ),
          TaskDocuments.TaskDocuments,
        );
        expect(yield* racing.save(save(opened, fixture + "draft")).pipe(Effect.flip)).toMatchObject(
          { _tag: "TaskDocumentConflict" },
        );
        expect(new Uint8Array(yield* fs.readFile(target))).toEqual(
          new TextEncoder().encode(external),
        );
        const failedFs = FileSystem.FileSystem.of({
          ...fs,
          rename: (from, to) =>
            fs.rename(to === target ? path.join(directory, "absent") : from, to),
        });
        const failing = Context.get(
          yield* Layer.build(
            Layer.fresh(
              TaskDocuments.layer.pipe(
                Layer.provide(Layer.succeed(FileSystem.FileSystem, failedFs)),
              ),
            ),
          ),
          TaskDocuments.TaskDocuments,
        );
        const current = yield* failing.open(opened.summary);
        const error = yield* failing
          .save(save(current, external + "retained draft"))
          .pipe(Effect.flip);
        expect(error).toMatchObject({ reason: "io" });
        if (error._tag !== "TaskDocumentError" || !error.recovery) return;
        expect((yield* service.readRecovery(error.recovery)).contents).toBe(
          external + "retained draft",
        );
        expect(new Uint8Array(yield* fs.readFile(target))).toEqual(
          new TextEncoder().encode(external),
        );
        expect(
          (yield* fs.readDirectory(directory)).filter((name) => name.endsWith(".tmp")),
        ).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "replaces on the host filesystem while an independent reader holds the old version",
    () =>
      Effect.gen(function* () {
        const { service, fs, target } = yield* setup;
        const opened = yield* service.register({ path: target });
        const mode = (yield* fs.stat(target)).mode & 0o777;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const oldHandle = yield* fs.open(target, { flag: "r" });
            const result = yield* service
              .save(save(opened, fixture + "replacement\r\n"))
              .pipe(Effect.result);
            if ((yield* HostProcess.Platform) === "win32") {
              expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "io" } });
              expect((yield* service.open(opened.summary)).contents).toBe(fixture);
            } else {
              expect(result._tag).toBe("Success");
            }
            const old = yield* oldHandle.readAlloc(TASK_DOCUMENT_MAX_BYTES);
            expect(old._tag).toBe("Some");
            if (old._tag === "Some")
              expect(new Uint8Array(old.value)).toEqual(new TextEncoder().encode(fixture));
          }),
        );
        const current = yield* service.open(opened.summary);
        const saved = yield* service.save(save(current, fixture + "retried replacement\r\n"));
        expect((yield* service.open(opened.summary)).contents).toBe(saved.contents);
        expect((yield* fs.stat(target)).mode & 0o777).toBe(mode);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "reads above preview limits completely and refuses oversized or non-UTF-8 documents",
    () =>
      Effect.gen(function* () {
        const { service, fs, target } = yield* setup;
        const contents = "x".repeat(1024 * 1024 + 1);
        yield* fs.writeFileString(target, contents);
        const opened = yield* service.register({ path: target });
        expect(opened.contents).toBe(contents);
        expect(yield* service.save(save(opened, "invalid\0text")).pipe(Effect.flip)).toMatchObject({
          reason: "unsupported",
        });
        expect(yield* fs.readFileString(target)).toBe(contents);
        yield* fs.writeFileString(target, "x".repeat(TASK_DOCUMENT_MAX_BYTES + 1));
        expect(yield* service.open(opened.summary).pipe(Effect.flip)).toMatchObject({
          reason: "too-large",
        });
        yield* fs.writeFile(target, new Uint8Array([0xff, 0xfe, 0x00]));
        expect(yield* service.open(opened.summary).pipe(Effect.flip)).toMatchObject({
          reason: "unsupported",
        });
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "observes selected external replacements and emits body-free catalogue invalidation",
    () =>
      Effect.gen(function* () {
        const { service, fs, target } = yield* setup;
        const opened = yield* service.register({ path: target });
        const notices = yield* Queue.unbounded<import("@t3tools/contracts").TaskDocumentNotice>();
        const watcher = yield* service.subscribeCatalogue().pipe(
          Stream.runForEach((notice) => Queue.offer(notices, notice)),
          Effect.forkScoped,
        );
        const documents = yield* Queue.unbounded<import("@t3tools/contracts").OpenTaskDocument>();
        yield* service.subscribeDocument(opened.summary).pipe(
          Stream.runForEach((document) => Queue.offer(documents, document)),
          Effect.forkScoped,
        );
        expect((yield* Queue.take(documents)).contents).toBe(fixture);
        yield* fs.writeFileString(target, fixture + "external");
        const changed = yield* Queue.take(documents);
        expect(changed.contents).toBe(fixture + "external");
        expect(yield* Queue.take(notices)).toEqual({
          taskDocumentId: opened.summary.taskDocumentId,
        });
        yield* Fiber.interrupt(watcher);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
