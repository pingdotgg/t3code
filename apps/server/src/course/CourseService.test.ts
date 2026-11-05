// @effect-diagnostics anyUnknownInErrorContext:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
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
