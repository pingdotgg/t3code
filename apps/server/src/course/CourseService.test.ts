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

  it.effect("stores problem text separately and reveals solutions only on request", () =>
    withService((service) =>
      Effect.gen(function* () {
        const course = yield* service.add({
          lessonThreadId: threadId,
          ingested: {
            kind: "ocw",
            title: "Mechanics",
            source: "https://ocw.mit.edu/courses/mechanics/",
            attribution: "MIT OpenCourseWare, Mechanics, CC BY-NC-SA 4.0",
            units: [{ title: "Week 1", section: "Week 1" }],
            problemSets: [
              { title: "Pset 1", section: "Week 1", text: "Problem", solution: "Solution" },
            ],
          },
        });
        assert.isFalse(JSON.stringify(course).includes("Problem"));
        const before = yield* service.problems({ courseId: course.id, pset: 1 });
        assert.strictEqual(before.problemSets[0]?.text, "Problem");
        assert.isUndefined(before.problemSets[0]?.solution);
        const reference = {
          label: "Posted solution",
          url: "https://example.com/solution",
          answers: "answer",
        };
        yield* service.update({ courseId: course.id, pset: 1, references: [reference] });
        const plain = yield* service.problems({ courseId: course.id, pset: 1 });
        assert.deepStrictEqual(plain.problemSets[0]?.references, [reference]);
        assert.include(plain.problemSets[0]?.note ?? "", "A reference is a check, not the truth");
        const revealed = yield* service.problems({ courseId: course.id, pset: 1, reveal: true });
        assert.strictEqual(revealed.problemSets[0]?.solution, "Solution");
        assert.strictEqual(revealed.attribution, "MIT OpenCourseWare, Mechanics, CC BY-NC-SA 4.0");
        const skipped = yield* service.problems({ courseId: course.id, pset: 1, skip: true });
        assert.strictEqual(skipped.problemSets[0]?.solution, "Solution");
        assert.deepStrictEqual(skipped.problemSets[0]?.references, [reference]);
        assert.include(skipped.problemSets[0]?.note ?? "", "**Skipped, not graded.**");
      }),
    ),
  );

  it.effect("stores published references and carries them through repair", () =>
    withService((service) =>
      Effect.gen(function* () {
        const ingested = {
          kind: "ocw" as const,
          title: "References",
          source: "source",
          units: [
            { title: "A", section: "Week" },
            { title: "B", section: "Week" },
          ],
          problemSets: [{ title: "Pset", section: "Week", text: "Problem" }],
        };
        const course = yield* service.add({ lessonThreadId: threadId, ingested });
        const references = [
          {
            label: "Student scan",
            url: "https://example.com/pset.pdf",
            answers: "1b: 7.3 m (using v² = v₀² + 2aΔy)",
          },
        ];
        yield* service.update({ courseId: course.id, pset: 1, references });
        const revealed = yield* service.problems({ courseId: course.id, pset: 1, reveal: true });
        assert.deepStrictEqual(revealed.problemSets[0]?.references, references);
        assert.include(revealed.problemSets[0]?.note ?? "", "published solution references");
        const repaired = yield* service.add({
          lessonThreadId: threadId,
          ingested: {
            ...ingested,
            units: [
              { title: "B", section: "Week" },
              { title: "A", section: "Week" },
            ],
          },
        });
        assert.deepStrictEqual(
          (yield* service.problems({ courseId: repaired.id, pset: 1, reveal: true })).problemSets[0]
            ?.references,
          references,
        );
      }),
    ),
  );

  it.effect("says when no published solution was found", () =>
    withService((service) =>
      Effect.gen(function* () {
        const course = yield* service.add({
          lessonThreadId: threadId,
          ingested: {
            kind: "ocw",
            title: "No references",
            source: "source",
            units: [{ title: "Week", section: "Week" }],
            problemSets: [{ title: "Pset", section: "Week", text: "Problem" }],
          },
        });
        yield* service.update({ courseId: course.id, pset: 1, references: [] });
        const result = yield* service.problems({ courseId: course.id, pset: 1, reveal: true });
        assert.include(result.problemSets[0]?.note ?? "", "no published solution was found online");
      }),
    ),
  );

  it.effect("carries each pset reference by title when psets reorder", () =>
    withService((service) =>
      Effect.gen(function* () {
        const source = {
          kind: "ocw" as const,
          title: "Reordered psets",
          source: "source",
          units: [{ title: "Week", section: "Week" }],
          problemSets: [
            { title: "Pset A", section: "Week", text: "A" },
            { title: "Pset B", section: "Week", text: "B" },
          ],
        };
        const course = yield* service.add({ lessonThreadId: threadId, ingested: source });
        const refs = [{ label: "B scan", url: "https://example.com/b", answers: "B" }];
        yield* service.update({ courseId: course.id, pset: 2, references: refs });
        yield* service.add({
          lessonThreadId: threadId,
          ingested: { ...source, problemSets: [source.problemSets[1]!, source.problemSets[0]!] },
        });
        const result = yield* service.problems({ courseId: course.id, pset: 1, reveal: true });
        assert.deepStrictEqual(result.problemSets[0]?.references, refs);
        assert.deepStrictEqual(
          (yield* service.get({ id: course.id })).problemSets?.[0]?.references,
          [{ label: "B scan", url: "https://example.com/b" }],
        );
      }),
    ),
  );

  it.effect("rejects unknown problem sets", () =>
    withService((service) =>
      Effect.gen(function* () {
        const course = yield* service.add({
          lessonThreadId: threadId,
          ingested: {
            kind: "ocw",
            title: "Unknown pset",
            source: "source",
            units: [{ title: "Week", section: "Week" }],
            problemSets: [{ title: "Pset 1", section: "Week", text: "Problem" }],
          },
        });
        const failure = yield* service.problems({ courseId: course.id, pset: 2 }).pipe(Effect.flip);
        assert.include(String(failure), "Problem set 2 was not found");
        const saveFailure = yield* service
          .update({ courseId: course.id, pset: 2, references: [] })
          .pipe(Effect.flip);
        assert.include(String(saveFailure), "Problem set 2 was not found");
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

  it.effect("backfills problem sets and remaps worked examples during repair", () =>
    withService((service) =>
      Effect.gen(function* () {
        const initial = yield* service.add({
          lessonThreadId: threadId,
          ingested: {
            kind: "ocw",
            title: "Backfill",
            source: "source",
            units: [{ title: "A" }, { title: "B" }],
          },
        });
        yield* service.update({
          courseId: initial.id,
          unit: 2,
          position: { unit: 2 },
          plan: "kept",
        });
        const repaired = yield* service.add({
          lessonThreadId: threadId,
          ingested: {
            kind: "ocw",
            title: "Backfill",
            source: "source",
            units: [
              { title: "X", section: "Week" },
              { title: "B", section: "Week" },
              { title: "A", section: "Week" },
            ],
            problemSets: [
              { title: "Pset", section: "Week", text: "Problem", workedExampleUnits: [3] },
            ],
          },
        });
        assert.strictEqual(repaired.position?.unit, 1);
        assert.deepStrictEqual(repaired.problemSets?.[0]?.workedExampleUnits, [2]);
        assert.strictEqual(
          (yield* service.problems({ courseId: repaired.id, pset: 1 })).problemSets[0]?.text,
          "Problem",
        );
      }),
    ),
  );

  it.effect("does not assign every problem set when a unit has no section", () =>
    withService((service) =>
      Effect.gen(function* () {
        const course = yield* service.add({
          lessonThreadId: threadId,
          ingested: {
            kind: "ocw",
            title: "Sections",
            source: "source",
            units: [{ title: "Unsectioned" }],
            problemSets: [{ title: "Pset", text: "Problem" }],
          },
        });
        const result = yield* service.problems({ courseId: course.id, unit: 1 });
        assert.deepStrictEqual(result.problemSets, []);
      }),
    ),
  );

  it.effect("remaps existing worked examples when a reorder has no incoming problem sets", () =>
    withService((service) =>
      Effect.gen(function* () {
        yield* service.add({
          lessonThreadId: threadId,
          ingested: {
            kind: "ocw",
            title: "Existing sets",
            source: "source",
            units: [{ title: "A" }, { title: "B" }],
            problemSets: [{ title: "Pset", text: "Problem", workedExampleUnits: [1] }],
          },
        });
        const repaired = yield* service.add({
          lessonThreadId: threadId,
          ingested: {
            kind: "ocw",
            title: "Existing sets",
            source: "source",
            units: [{ title: "X" }, { title: "B" }, { title: "A" }],
          },
        });
        assert.deepStrictEqual(repaired.problemSets?.[0]?.workedExampleUnits, [2]);
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
