// @effect-diagnostics effectFnOpportunity:off
import {
  Course,
  CourseError,
  CourseSummary,
  type CoursePosition,
  type CourseUnit,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { fetchYoutubeTranscript, transcriptWindow, type IngestedCourse } from "./ingest.ts";

export type CourseAddInput =
  | { readonly lessonThreadId: ThreadId; readonly ingested: IngestedCourse }
  | {
      readonly lessonThreadId: ThreadId;
      readonly title: string;
      readonly units: ReadonlyArray<string>;
    };

export interface CourseReadUnit {
  readonly course: Course;
  readonly unit: CourseUnit;
  readonly index: number;
  readonly text: string;
  readonly plan?: string;
  readonly quiz?: string;
}

export class CourseService extends Context.Service<
  CourseService,
  {
    readonly add: (input: CourseAddInput) => Effect.Effect<Course, CourseError>;
    readonly list: Effect.Effect<ReadonlyArray<CourseSummary>, CourseError>;
    readonly get: (input: {
      readonly id?: string;
      readonly lessonThreadId?: ThreadId;
    }) => Effect.Effect<Course, CourseError>;
    readonly readUnit: (input: {
      readonly courseId: string;
      readonly unit: number;
      readonly at?: number;
    }) => Effect.Effect<CourseReadUnit, CourseError, ProcessRunner.ProcessRunner>;
    readonly update: (input: {
      readonly courseId: string;
      readonly position?: CoursePosition;
      readonly unit?: number;
      readonly plan?: string;
      readonly quiz?: string;
      readonly transcript?: string;
    }) => Effect.Effect<Course, CourseError>;
    readonly remove: (courseId: string) => Effect.Effect<void, CourseError>;
    readonly recordPrepThread: (
      courseId: string,
      threadId: ThreadId,
    ) => Effect.Effect<Course, CourseError>;
    readonly clearCachedClips: Effect.Effect<number, CourseError>;
    readonly cachedConcepts: Effect.Effect<
      ReadonlyArray<{
        readonly concept: string;
        readonly title: string;
        readonly courseId?: string;
      }>,
      CourseError
    >;
  }
>()("t3/course/CourseService") {}

const decodeCourse = Schema.decodeEffect(Schema.fromJsonString(Course));
const encodeCourse = Schema.encodeEffect(Schema.fromJsonString(Course, { space: 2 }));
const decodeVisualMeta = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({
      concept: Schema.String,
      title: Schema.String,
      courseId: Schema.optionalKey(Schema.String),
    }),
  ),
);
const slug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80)
    .replace(/^-|-$/g, "") || "course";
const failure = (message: string) => new CourseError({ message });
const isCourseError = Schema.is(CourseError);
const isCourseId = (id: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);

export const courseBelongsToThread = (course: Course, threadId: ThreadId) =>
  course.lessonThreadId === threadId || course.prepThreadIds.includes(threadId);

export const make = Effect.fn("CourseService.make")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const root = path.join(stateDir, "courses");
  const unitFile = (id: string, unit: number, ext: string) =>
    path.join(root, id, "units", `${String(unit).padStart(2, "0")}.${ext}`);
  const locked = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
    lock
      .withPermit(effect)
      .pipe(Effect.mapError((error) => (isCourseError(error) ? error : failure(error.message))));

  const read = Effect.fn("CourseService.read")(function* (id: string) {
    if (!isCourseId(id)) return yield* failure("Invalid course id.");
    const file = path.join(root, id, "course.json");
    if (!(yield* fs.exists(file))) return yield* failure(`Course '${id}' was not found.`);
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeCourse),
      Effect.mapError(() => failure(`${file} is not a valid course; fix or remove it.`)),
    );
  });

  // Entries that fail to read are skipped here and never overwritten.
  const readAll = Effect.gen(function* () {
    if (!(yield* fs.exists(root))) return { taken: new Set<string>(), courses: [] };
    const entries = yield* fs.readDirectory(root);
    const courses = yield* Effect.forEach(entries, (id) => Effect.option(read(id)));
    return {
      taken: new Set(entries),
      courses: courses.flatMap((course) => (course._tag === "Some" ? [course.value] : [])),
    };
  });

  const write = Effect.fn("CourseService.write")(function* (course: Course) {
    const json = yield* encodeCourse(course).pipe(
      Effect.mapError((error) =>
        failure(`The course is invalid and was not saved: ${error.message}`),
      ),
    );
    const file = path.join(root, course.id, "course.json");
    yield* fs.makeDirectory(path.join(root, course.id, "units"), { recursive: true });
    yield* fs.writeFileString(`${file}.tmp`, `${json}\n`);
    yield* fs.rename(`${file}.tmp`, file);
  });

  const add = Effect.fn("CourseService.add")(function* (input: CourseAddInput) {
    const source: IngestedCourse =
      "ingested" in input
        ? input.ingested
        : {
            kind: "ours",
            title: input.title,
            source: "",
            units: input.units.map((title) => ({ title })),
          };
    const title = source.title.trim();
    return yield* locked(
      Effect.gen(function* () {
        const { taken, courses } = yield* readAll;
        const linked = courses.filter((course) => course.lessonThreadId === input.lessonThreadId);
        const same = linked.find((course) => course.title === title);
        if (same) return same;
        const base = slug(title);
        let id = base;
        for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
        const course: Course = {
          id,
          kind: source.kind,
          title,
          ...(source.source ? { source: source.source } : {}),
          ...(source.license ? { license: source.license } : {}),
          ...(source.attribution ? { attribution: source.attribution } : {}),
          lessonThreadId: input.lessonThreadId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          units: source.units.map((unit) => ({
            title: unit.title.trim(),
            ...(unit.youtubeId ? { youtubeId: unit.youtubeId } : {}),
            ...(unit.pages ? { pages: unit.pages } : {}),
            hasText: unit.text !== undefined,
            prepared: { plan: false, quiz: false },
          })),
          prepThreadIds: [],
        };
        yield* write(course);
        yield* Effect.forEach(
          source.units,
          (unit, index) =>
            unit.text === undefined
              ? Effect.void
              : fs.writeFileString(unitFile(id, index + 1, "txt"), unit.text),
          { discard: true },
        );
        // One course per lesson: the new one replaces the lesson's old course.
        yield* Effect.forEach(
          linked,
          (old) => fs.remove(path.join(root, old.id), { recursive: true }),
          { discard: true },
        );
        return course;
      }),
    );
  });

  const list = locked(
    readAll.pipe(
      Effect.map(({ courses }) =>
        courses.map((course) => ({
          id: course.id,
          kind: course.kind,
          title: course.title,
          unitCount: course.units.length,
          ...(course.position ? { position: course.position } : {}),
          ...(course.attribution ? { attribution: course.attribution } : {}),
        })),
      ),
    ),
  );

  const get = Effect.fn("CourseService.get")(function* (input: {
    readonly id?: string;
    readonly lessonThreadId?: ThreadId;
  }) {
    return yield* locked(
      Effect.gen(function* () {
        if (input.id) return yield* read(input.id);
        const { courses } = yield* readAll;
        const course = courses.find(
          (candidate) => candidate.lessonThreadId === input.lessonThreadId,
        );
        return course ?? (yield* failure("No course is linked to this lesson."));
      }),
    );
  });

  const readUnit = Effect.fn("CourseService.readUnit")(function* (input: {
    readonly courseId: string;
    readonly unit: number;
    readonly at?: number;
  }) {
    const index = input.unit - 1;
    const loaded = yield* locked(
      Effect.gen(function* () {
        const course = yield* read(input.courseId);
        const unit = course.units[index];
        if (!unit) return yield* failure(`Unit ${input.unit} was not found.`);
        const files = {
          text: unitFile(course.id, input.unit, "txt"),
          plan: unitFile(course.id, input.unit, "plan.md"),
          quiz: unitFile(course.id, input.unit, "quiz.md"),
        };
        return {
          course,
          unit,
          text: (yield* fs.exists(files.text)) ? yield* fs.readFileString(files.text) : "",
          plan:
            unit.prepared.plan && (yield* fs.exists(files.plan))
              ? yield* fs.readFileString(files.plan)
              : undefined,
          quiz:
            unit.prepared.quiz && (yield* fs.exists(files.quiz))
              ? yield* fs.readFileString(files.quiz)
              : undefined,
        };
      }),
    );
    let { course, text } = loaded;
    if (!text && loaded.unit.youtubeId) {
      const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
      const ytDlp =
        settings._tag === "Some" &&
        (yield* settings.value.getSettings.pipe(Effect.mapError((error) => failure(error.message))))
          .courseYtDlp;
      if (ytDlp) {
        // Fetched outside the lock: yt-dlp can take minutes.
        const fetched = yield* fetchYoutubeTranscript(loaded.unit.youtubeId).pipe(
          Effect.mapError((error) => failure(error.message)),
        );
        text = fetched;
        course = yield* locked(
          Effect.gen(function* () {
            const current = yield* read(input.courseId);
            yield* fs.writeFileString(unitFile(current.id, input.unit, "txt"), fetched);
            const next = {
              ...current,
              units: current.units.map((candidate, i) =>
                i === index ? { ...candidate, hasText: true } : candidate,
              ),
            };
            yield* write(next);
            return next;
          }),
        );
      } else {
        text =
          "No transcript is cached. Ask the learner to paste it, then save it with course_update transcript.";
      }
    }
    return {
      course,
      unit: course.units[index] ?? loaded.unit,
      index,
      text: input.at === undefined ? text.slice(0, 4000) : transcriptWindow(text, input.at, 180),
      ...(loaded.plan ? { plan: loaded.plan } : {}),
      ...(loaded.quiz ? { quiz: loaded.quiz } : {}),
    };
  });

  const update = Effect.fn("CourseService.update")(function* (input: {
    readonly courseId: string;
    readonly position?: CoursePosition;
    readonly unit?: number;
    readonly plan?: string;
    readonly quiz?: string;
    readonly transcript?: string;
  }) {
    return yield* locked(
      Effect.gen(function* () {
        const course = yield* read(input.courseId);
        const next = input.position ? { ...course, position: input.position } : course;
        if (input.unit === undefined) {
          yield* write(next);
          return next;
        }
        const index = input.unit - 1;
        if (!next.units[index]) return yield* failure(`Unit ${input.unit} was not found.`);
        yield* fs.makeDirectory(path.join(root, next.id, "units"), { recursive: true });
        if (input.plan !== undefined)
          yield* fs.writeFileString(unitFile(next.id, input.unit, "plan.md"), input.plan);
        if (input.quiz !== undefined)
          yield* fs.writeFileString(unitFile(next.id, input.unit, "quiz.md"), input.quiz);
        if (input.transcript !== undefined)
          yield* fs.writeFileString(unitFile(next.id, input.unit, "txt"), input.transcript);
        const units = next.units.map((unit, i) =>
          i === index
            ? {
                ...unit,
                hasText: input.transcript === undefined ? unit.hasText : true,
                prepared: {
                  plan: input.plan === undefined ? unit.prepared.plan : true,
                  quiz: input.quiz === undefined ? unit.prepared.quiz : true,
                },
              }
            : unit,
        );
        const result = { ...next, units };
        yield* write(result);
        return result;
      }),
    );
  });

  const remove = Effect.fn("CourseService.remove")(function* (id: string) {
    if (!isCourseId(id)) return yield* failure("Invalid course id.");
    yield* locked(fs.remove(path.join(root, id), { recursive: true }));
  });
  const recordPrepThread = Effect.fn("CourseService.recordPrepThread")(function* (
    courseId: string,
    threadId: ThreadId,
  ) {
    return yield* locked(
      Effect.gen(function* () {
        const course = yield* read(courseId);
        if (course.prepThreadIds.includes(threadId)) return course;
        const next = { ...course, prepThreadIds: [...course.prepThreadIds, threadId] };
        yield* write(next);
        return next;
      }),
    );
  });
  const visuals = path.join(stateDir, "visuals");
  const clearCachedClips = locked(
    Effect.gen(function* () {
      if (!(yield* fs.exists(visuals))) return 0;
      const entries = (yield* fs.readDirectory(visuals)).filter(isCourseId);
      yield* Effect.forEach(
        entries,
        (entry) => fs.remove(path.join(visuals, entry), { recursive: true }),
        { discard: true },
      );
      return entries.length;
    }),
  );
  const cachedConcepts = locked(
    Effect.gen(function* () {
      if (!(yield* fs.exists(visuals))) return [];
      const concepts: Array<{ concept: string; title: string; courseId?: string }> = [];
      for (const entry of (yield* fs.readDirectory(visuals)).filter(isCourseId)) {
        const metaPath = path.join(visuals, entry, "meta.json");
        if (!(yield* fs.exists(metaPath))) continue;
        const meta = decodeVisualMeta(yield* fs.readFileString(metaPath));
        if (meta._tag === "Some") concepts.push(meta.value);
      }
      return concepts;
    }),
  );
  return CourseService.of({
    add,
    list,
    get,
    readUnit,
    update,
    remove,
    recordPrepThread,
    clearCachedClips,
    cachedConcepts,
  });
});

export const layer = Layer.effect(
  CourseService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* make(config.stateDir);
  }),
);

export const unavailable = CourseService.of({
  add: () => Effect.fail(failure("Courses are unavailable.")),
  list: Effect.fail(failure("Courses are unavailable.")),
  get: () => Effect.fail(failure("Courses are unavailable.")),
  readUnit: () => Effect.fail(failure("Courses are unavailable.")),
  update: () => Effect.fail(failure("Courses are unavailable.")),
  remove: () => Effect.fail(failure("Courses are unavailable.")),
  recordPrepThread: () => Effect.fail(failure("Courses are unavailable.")),
  clearCachedClips: Effect.fail(failure("Courses are unavailable.")),
  cachedConcepts: Effect.fail(failure("Courses are unavailable.")),
});
