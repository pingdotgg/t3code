// @effect-diagnostics anyUnknownInErrorContext:off nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CourseService from "./CourseService.ts";

const threadId = ThreadId.make("lesson-1");
const withService = <A>(
  body: (
    service: CourseService.CourseService["Service"],
    dir: string,
  ) => Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner>,
) =>
  Effect.gen(function* () {
    const dir = (yield* Path.Path).join(
      yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
      "state",
    );
    return yield* body(yield* CourseService.make(dir), dir);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(ProcessRunner.ProcessRunner, { run: () => Effect.die("not used") }),
  );

describe("CourseService", () => {
  it.effect("adds, reads, updates and removes a course", () =>
    withService((service, dir) =>
      Effect.gen(function* () {
        const course = yield* service.add({
          lessonThreadId: threadId,
          title: "Linear Algebra",
          units: ["Vectors", "Matrices"],
        });
        assert.strictEqual((yield* service.get({ lessonThreadId: threadId })).id, course.id);
        yield* service.update({ courseId: course.id, unit: 1, plan: "sticking points" });
        assert.isTrue((yield* service.get({ id: course.id })).units[0]!.prepared.plan);
        yield* service.remove(course.id);
        assert.isFalse(
          yield* (yield* FileSystem.FileSystem).exists(
            (yield* Path.Path).join(dir, "courses", course.id),
          ),
        );
      }),
    ),
  );

  it.effect("returns only the transcript window", () =>
    withService((service) =>
      Effect.gen(function* () {
        const course = yield* service.add({
          lessonThreadId: threadId,
          title: "Signals",
          units: ["Lecture"],
        });
        yield* service.update({
          courseId: course.id,
          unit: 1,
          transcript: "[00:00] start\n[01:00] near\n[10:00] far",
        });
        const unit = yield* service.readUnit({ courseId: course.id, unit: 1, at: 60 });
        assert.include(unit.text, "near");
        assert.notInclude(unit.text, "far");
      }),
    ),
  );

  it.effect("writes a lazy transcript to the fetched unit after repair", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const runner = {
        run: (input: { args: ReadonlyArray<string> }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
            const out = input.args[input.args.indexOf("--output") + 1]!;
            const id = input.args.at(-1)!.split("v=")[1]!;
            NodeFS.writeFileSync(
              NodePath.join(NodePath.dirname(out), `${id}.en.json3`),
              JSON.stringify({
                events: [{ tStartMs: 0, segs: [{ utf8: `transcript of ${id}` }] }],
              }),
            );
            return { code: 0, stdout: "", stderr: "" };
          }),
      } as unknown as ProcessRunner.ProcessRunner["Service"];
      const dir = (yield* Path.Path).join(
        yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
        "state",
      );
      const service = yield* CourseService.make(dir);
      const ingested = {
        kind: "ocw" as const,
        title: "Mechanics",
        source: "https://ocw.mit.edu/courses/mechanics/",
        units: [
          { title: "Lecture 21", youtubeId: "video21" },
          { title: "Lecture 1", youtubeId: "video1" },
        ],
      };
      const course = yield* service.add({ lessonThreadId: threadId, ingested });
      const fiber = yield* service
        .readUnit({ courseId: course.id, unit: 1 })
        .pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner), Effect.forkChild);
      yield* Deferred.await(started);
      yield* service.add({
        lessonThreadId: threadId,
        ingested: { ...ingested, units: [ingested.units[1]!, ingested.units[0]!] },
      });
      yield* Deferred.succeed(gate, undefined);
      assert.strictEqual((yield* Fiber.join(fiber)).unit.youtubeId, "video21");
      const noFetch = {
        run: () => Effect.die("no fetch"),
      } as unknown as ProcessRunner.ProcessRunner["Service"];
      const noFetchSettings = {
        getSettings: Effect.succeed({ courseYtDlp: false }),
      } as unknown as ServerSettings.ServerSettingsService["Service"];
      const unit1 = yield* service
        .readUnit({ courseId: course.id, unit: 1 })
        .pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, noFetch),
          Effect.provideService(ServerSettings.ServerSettingsService, noFetchSettings),
        );
      assert.notInclude(unit1.text, "video21");
      const unit2 = yield* service
        .readUnit({ courseId: course.id, unit: 2 })
        .pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, noFetch),
          Effect.provideService(ServerSettings.ServerSettingsService, noFetchSettings),
        );
      assert.include(unit2.text, "video21");
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        getSettings: Effect.succeed({ courseYtDlp: true }),
      } as unknown as ServerSettings.ServerSettingsService["Service"]),
    ),
  );

  it.effect("repairs an existing course's order while keeping unit files and progress", () =>
    withService((service) =>
      Effect.gen(function* () {
        const ingested = {
          kind: "ocw" as const,
          title: "Mechanics",
          source: "https://ocw.mit.edu/courses/mechanics/",
          license: "CC BY-NC-SA 4.0",
          attribution: "MIT OpenCourseWare",
          units: [
            { title: "Lecture 21", youtubeId: "video21", text: "[00:00] Work" },
            { title: "Lecture 1", youtubeId: "video1", text: "[00:00] Vectors" },
            { title: "Title only", text: "Extra" },
            { title: "Unmatched A", text: "Keep A" },
            { title: "Unmatched B", text: "Keep B" },
          ],
        };
        const course = yield* service.add({ lessonThreadId: threadId, ingested });
        yield* service.update({
          courseId: course.id,
          unit: 1,
          plan: "Work plan",
          quiz: "Work quiz",
          position: { unit: 1, at: 90 },
        });
        yield* service.update({ courseId: course.id, unit: 2, plan: "Vector plan" });
        yield* service.recordPrepThread(course.id, ThreadId.make("prep-1"));
        const before = yield* service.get({ id: course.id });
        const repaired = yield* service.add({
          lessonThreadId: threadId,
          ingested: {
            ...ingested,
            units: [
              { title: "Renamed lecture 1", youtubeId: "video1" },
              { title: "Title only" },
              { title: "Lecture 21", youtubeId: "video21" },
              { title: "New lecture" },
            ],
          },
        });
        assert.deepStrictEqual(repaired, {
          ...before,
          units: [
            before.units[1]!,
            before.units[2]!,
            before.units[0]!,
            before.units[3]!,
            before.units[4]!,
          ],
          position: { unit: 3, at: 90 },
        });
        const work = yield* service.readUnit({ courseId: course.id, unit: 3 });
        assert.strictEqual(work.plan, "Work plan");
        assert.strictEqual(work.quiz, "Work quiz");
        assert.strictEqual(work.text, "[00:00] Work");
        const vectors = yield* service.readUnit({ courseId: course.id, unit: 1 });
        assert.strictEqual(vectors.plan, "Vector plan");
        assert.strictEqual(vectors.text, "[00:00] Vectors");
        assert.isUndefined((yield* service.readUnit({ courseId: course.id, unit: 2 })).plan);
        assert.deepStrictEqual(yield* service.get({ id: course.id }), repaired);
        assert.deepStrictEqual(
          yield* service.add({
            lessonThreadId: threadId,
            ingested: {
              ...ingested,
              units: [ingested.units[1]!, ingested.units[2]!, ingested.units[0]!],
            },
          }),
          repaired,
        );
      }),
    ),
  );

  it.effect("rejects traversal ids without deleting outside courses", () =>
    withService((service, dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(dir, "courses"), { recursive: true });
        const sentinel = path.join(dir, "outside.txt");
        yield* fs.writeFileString(sentinel, "keep");
        const failure = yield* service.remove("..").pipe(Effect.flip);
        assert.strictEqual(failure.message, "Invalid course id.");
        assert.isTrue(yield* fs.exists(sentinel));
      }),
    ),
  );

  it.effect("gives another lesson's same-titled course its own folder", () =>
    withService((service) =>
      Effect.gen(function* () {
        const first = yield* service.add({ lessonThreadId: threadId, title: "Курс", units: ["A"] });
        yield* service.update({ courseId: first.id, unit: 1, plan: "first lesson's plan" });
        const second = yield* service.add({
          lessonThreadId: ThreadId.make("lesson-2"),
          title: "Другой курс",
          units: ["B"],
        });
        assert.notStrictEqual(second.id, first.id);
        assert.isUndefined((yield* service.readUnit({ courseId: second.id, unit: 1 })).plan);
        assert.strictEqual((yield* service.get({ id: first.id })).lessonThreadId, threadId);
      }),
    ),
  );

  it.effect("adds beside a corrupt course without touching it", () =>
    withService((service, dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(dir, "courses", "broken", "course.json");
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "not json");
        const course = yield* service.add({
          lessonThreadId: threadId,
          title: "Broken",
          units: ["One"],
        });
        assert.notStrictEqual(course.id, "broken");
        assert.strictEqual((yield* service.list).length, 1);
        assert.strictEqual(yield* fs.readFileString(file), "not json");
      }),
    ),
  );

  it.effect("refuses to save an invalid course", () =>
    withService((service, dir) =>
      Effect.gen(function* () {
        const failure = yield* service
          .add({ lessonThreadId: threadId, title: "Blank unit", units: [" "] })
          .pipe(Effect.flip);
        assert.include(failure.message, "invalid");
        assert.isFalse(
          yield* (yield* FileSystem.FileSystem).exists(
            (yield* Path.Path).join(dir, "courses", "blank-unit"),
          ),
        );
      }),
    ),
  );
});
