// @effect-diagnostics effectFnOpportunity:off
import {
  Course,
  CourseError,
  CourseSummary,
  CourseProblemReference,
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

export interface CourseProblems {
  readonly attribution?: string;
  readonly problemSets: ReadonlyArray<{
    readonly number: number;
    readonly title: string;
    readonly section?: string;
    readonly text?: string;
    readonly solution?: string | null;
    readonly references?: ReadonlyArray<CourseProblemReference>;
    readonly note?: string;
    readonly workedExampleUnits?: ReadonlyArray<{ readonly unit: number; readonly title: string }>;
  }>;
  readonly note?: string;
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
    readonly problems: (input: {
      readonly courseId: string;
      readonly unit?: number;
      readonly pset?: number;
      readonly reveal?: boolean;
      readonly skip?: boolean;
    }) => Effect.Effect<CourseProblems, CourseError>;
    readonly update: (input: {
      readonly courseId: string;
      readonly position?: CoursePosition;
      readonly unit?: number;
      readonly plan?: string;
      readonly quiz?: string;
      readonly transcript?: string;
      readonly pset?: number;
      readonly references?: ReadonlyArray<CourseProblemReference>;
      readonly solutionSearchedAt?: string;
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
  const psetFile = (baseDir: string, pset: number, solution = false) =>
    path.join(
      baseDir,
      "psets",
      `${String(pset).padStart(2, "0")}${solution ? ".solution" : ""}.txt`,
    );
  const referencesFile = (baseDir: string, pset: number) =>
    path.join(baseDir, "psets", `${String(pset).padStart(2, "0")}.references.json`);
  const referencesSchema = Schema.Array(CourseProblemReference);
  const decodeReferencesJson = Schema.decodeEffect(Schema.fromJsonString(referencesSchema));
  const readReferences = Effect.fn("CourseService.readReferences")(function* (
    baseDir: string,
    pset: number,
  ) {
    const file = referencesFile(baseDir, pset);
    if (!(yield* fs.exists(file))) return undefined;
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap(decodeReferencesJson),
      Effect.mapError(() => failure(`${file} is not a valid references file; fix or remove it.`)),
    );
  });
  const writeReferences = (
    baseDir: string,
    pset: number,
    references: ReadonlyArray<CourseProblemReference>,
  ) =>
    fs.writeFileString(referencesFile(baseDir, pset), `${JSON.stringify(references, null, 2)}\n`);
  const problemSetMetadata = (
    source: IngestedCourse,
    remap?: (unit: number) => number | undefined,
  ) =>
    source.problemSets?.map((pset) => ({
      title: pset.title.trim(),
      ...(pset.section ? { section: pset.section } : {}),
      hasSolution: pset.solution !== undefined,
      ...(pset.workedExampleUnits?.length
        ? {
            workedExampleUnits: pset.workedExampleUnits
              .map((unit) => (remap ? remap(unit) : unit))
              .filter((unit): unit is number => unit !== undefined),
          }
        : {}),
    }));
  const writeProblemSets = (
    baseDir: string,
    problemSets: NonNullable<IngestedCourse["problemSets"]>,
  ) =>
    Effect.forEach(
      problemSets,
      (pset, index) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.join(baseDir, "psets"), { recursive: true });
          yield* fs.writeFileString(psetFile(baseDir, index + 1), pset.text);
          if (pset.solution !== undefined)
            yield* fs.writeFileString(psetFile(baseDir, index + 1, true), pset.solution);
        }),
      { discard: true },
    );
  const locked = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
    lock
      .withPermit(effect)
      .pipe(Effect.mapError((error) => (isCourseError(error) ? error : failure(error.message))));

  // The staged metadata marks a complete repair; a read finishes an interrupted directory swap.
  const finishRepair = Effect.fn("CourseService.finishRepair")(function* (id: string) {
    const directory = path.join(root, id);
    const staged = path.join(directory, ".reorder");
    const metadata = path.join(staged, "course.json");
    if (!(yield* fs.exists(metadata))) return;
    const units = path.join(directory, "units");
    const oldUnits = path.join(staged, "old-units");
    if (yield* fs.exists(path.join(staged, "units"))) {
      if (!(yield* fs.exists(oldUnits)) && (yield* fs.exists(units)))
        yield* fs.rename(units, oldUnits);
      yield* fs.rename(path.join(staged, "units"), units);
    }
    if (yield* fs.exists(path.join(staged, "psets"))) {
      const oldPsets = path.join(staged, "old-psets");
      const psets = path.join(directory, "psets");
      if (!(yield* fs.exists(oldPsets)) && (yield* fs.exists(psets)))
        yield* fs.rename(psets, oldPsets);
      yield* fs.rename(path.join(staged, "psets"), psets);
    }
    yield* fs.rename(metadata, path.join(directory, "course.json"));
    yield* fs.remove(staged, { recursive: true });
  });

  const read = Effect.fn("CourseService.read")(function* (id: string) {
    if (!isCourseId(id)) return yield* failure("Invalid course id.");
    yield* finishRepair(id);
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

  const repair = Effect.fn("CourseService.repair")(function* (
    course: Course,
    source: IngestedCourse,
  ) {
    const available = new Set(course.units.map((_, index) => index));
    const matches = source.units.map(() => -1);
    for (const key of ["youtubeId", "title"] as const) {
      source.units.forEach((incoming, position) => {
        if (matches[position] !== -1 || !incoming[key]) return;
        const index = course.units.findIndex(
          (unit, index) => available.has(index) && unit[key] === incoming[key]?.trim(),
        );
        if (index < 0) return;
        available.delete(index);
        matches[position] = index;
      });
    }
    const matched = [...matches.filter((index) => index >= 0), ...available];
    const remap = (unit: number) => {
      const old = matches[unit - 1];
      const next = old === undefined ? undefined : matched.indexOf(old);
      return next === undefined || next < 0 ? undefined : next + 1;
    };
    const remapExisting = (unit: number) => {
      const next = matched.indexOf(unit - 1);
      return next < 0 ? undefined : next + 1;
    };
    const problemSets = source.problemSets
      ? problemSetMetadata(source, remap)?.map((pset) => ({
          ...pset,
          ...(course.problemSets?.find((old) => old.title === pset.title)?.references
            ? { references: course.problemSets.find((old) => old.title === pset.title)!.references }
            : {}),
        }))
      : course.problemSets?.map((pset) => ({
          ...pset,
          ...(pset.workedExampleUnits
            ? {
                workedExampleUnits: pset.workedExampleUnits
                  .map(remapExisting)
                  .filter((unit): unit is number => unit !== undefined),
              }
            : {}),
        }));
    const next = {
      ...course,
      units: matched.map((index) => ({
        ...course.units[index]!,
        ...(source.units[matches.indexOf(index)]?.section
          ? { section: source.units[matches.indexOf(index)]!.section }
          : {}),
      })),
      ...(problemSets ? { problemSets } : {}),
    };
    if (matched.every((index, position) => index === position) && !source.problemSets)
      return course;
    const positionIndex = course.position ? matched.indexOf(course.position.unit - 1) : -1;
    const position =
      course.position && positionIndex >= 0
        ? { ...course.position, unit: positionIndex + 1 }
        : course.position;
    const positioned = { ...next, ...(position ? { position } : {}) };
    const staged = path.join(root, course.id, ".reorder");
    yield* fs.remove(staged, { recursive: true, force: true });
    yield* fs.makeDirectory(path.join(staged, "units"), { recursive: true });
    for (const [newIndex, oldIndex] of matched.entries()) {
      for (const ext of ["txt", "plan.md", "quiz.md"]) {
        const from = unitFile(course.id, oldIndex + 1, ext);
        if (yield* fs.exists(from))
          yield* fs.copyFile(
            from,
            path.join(staged, "units", `${String(newIndex + 1).padStart(2, "0")}.${ext}`),
          );
      }
    }
    if (source.problemSets) {
      yield* fs.makeDirectory(path.join(staged, "psets"), { recursive: true });
      yield* writeProblemSets(staged, source.problemSets);
      for (const [index, incoming] of source.problemSets.entries()) {
        const oldIndex = course.problemSets?.findIndex((old) => old.title === incoming.title) ?? -1;
        if (oldIndex < 0) continue;
        const references = yield* readReferences(path.join(root, course.id), oldIndex + 1);
        if (references !== undefined) yield* writeReferences(staged, index + 1, references);
      }
    }
    const json = yield* encodeCourse(positioned).pipe(
      Effect.mapError(() => failure("The reordered course is invalid and was not saved.")),
    );
    yield* fs.writeFileString(path.join(staged, "course.json.tmp"), `${json}\n`);
    yield* fs.rename(path.join(staged, "course.json.tmp"), path.join(staged, "course.json"));
    yield* finishRepair(course.id);
    return positioned;
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
        if (same && "ingested" in input && same.kind === source.kind)
          return yield* repair(same, source);
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
            ...(unit.section ? { section: unit.section } : {}),
            prepared: { plan: false, quiz: false },
          })),
          prepThreadIds: [],
          ...(source.problemSets
            ? {
                problemSets: problemSetMetadata(source),
              }
            : {}),
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
        if (source.problemSets) {
          yield* writeProblemSets(path.join(root, id), source.problemSets);
        }
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
    let resultIndex = index;
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
        const repaired = yield* locked(
          Effect.gen(function* () {
            const current = yield* read(input.courseId);
            const currentIndex = current.units.findIndex(
              (candidate) => candidate.youtubeId === loaded.unit.youtubeId,
            );
            if (currentIndex < 0) return { course: current, index: -1 };
            yield* fs.writeFileString(unitFile(current.id, currentIndex + 1, "txt"), fetched);
            const next = {
              ...current,
              units: current.units.map((candidate, i) =>
                i === currentIndex ? { ...candidate, hasText: true } : candidate,
              ),
            };
            yield* write(next);
            return { course: next, index: currentIndex };
          }),
        );
        resultIndex = repaired.index < 0 ? index : repaired.index;
        course = repaired.course;
      } else {
        text =
          "No transcript is cached. Ask the learner to paste it, then save it with course_update transcript.";
      }
    }
    return {
      course,
      unit: course.units[resultIndex] ?? loaded.unit,
      index: resultIndex,
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
    readonly pset?: number;
    readonly references?: ReadonlyArray<CourseProblemReference>;
    readonly solutionSearchedAt?: string;
  }) {
    return yield* locked(
      Effect.gen(function* () {
        const course = yield* read(input.courseId);
        if (input.references !== undefined && input.pset === undefined)
          return yield* failure("pset is required with references.");
        if (input.pset !== undefined && input.references === undefined)
          return yield* failure("references are required with pset.");
        if (input.pset !== undefined && input.unit !== undefined)
          return yield* failure("pset updates cannot include a unit.");
        if (
          input.pset !== undefined &&
          (!course.problemSets || !course.problemSets[input.pset - 1])
        )
          return yield* failure(`Problem set ${input.pset} was not found.`);
        const next = {
          ...course,
          ...(input.position ? { position: input.position } : {}),
          ...(input.solutionSearchedAt ? { solutionSearchedAt: input.solutionSearchedAt } : {}),
        };
        if (input.unit === undefined) {
          if (input.pset === undefined) {
            yield* write(next);
            return next;
          }
          const index = input.pset - 1;
          const problemSets = next.problemSets!.map((pset, i) =>
            i === index
              ? {
                  ...pset,
                  references: input.references!.map(({ label, url }) => ({ label, url })),
                }
              : pset,
          );
          const result = { ...next, problemSets };
          yield* fs.makeDirectory(path.join(root, next.id, "psets"), { recursive: true });
          yield* writeReferences(path.join(root, next.id), input.pset, input.references!);
          yield* write(result);
          return result;
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

  const problems = Effect.fn("CourseService.problems")(function* (input: {
    readonly courseId: string;
    readonly unit?: number;
    readonly pset?: number;
    readonly reveal?: boolean;
    readonly skip?: boolean;
  }) {
    return yield* locked(
      Effect.gen(function* () {
        const course = yield* read(input.courseId);
        if (input.skip && input.pset === undefined)
          return yield* failure("pset is required with skip");
        const attribution = course.attribution ? { attribution: course.attribution } : {};
        if (!course.problemSets)
          return {
            ...attribution,
            problemSets: [],
            note:
              course.kind === "ocw"
                ? "No problem sets saved for this course. Call course_add with the course source again to fetch them."
                : "This course has no problem sets.",
          };
        const selected =
          input.pset !== undefined
            ? course.problemSets.slice(input.pset - 1, input.pset)
            : input.unit !== undefined
              ? course.problemSets.filter(
                  (pset) =>
                    course.units[input.unit! - 1]?.section !== undefined &&
                    pset.section === course.units[input.unit! - 1]?.section,
                )
              : course.problemSets;
        if (input.pset !== undefined && !selected.length)
          return yield* failure(`Problem set ${input.pset} was not found.`);
        const result = yield* Effect.forEach(selected, (pset) =>
          Effect.gen(function* () {
            const number = course.problemSets!.indexOf(pset) + 1;
            const item = {
              number,
              title: pset.title,
              ...(pset.section ? { section: pset.section } : {}),
              ...(pset.workedExampleUnits
                ? {
                    workedExampleUnits: pset.workedExampleUnits.map((unit) => ({
                      unit,
                      title: course.units[unit - 1]?.title ?? "",
                    })),
                  }
                : {}),
            };
            const references = yield* readReferences(path.join(root, course.id), number);
            const referencesNote =
              references === undefined || references.length === 0
                ? "No published solution was found online. A reference is a check, not the truth. If your worked answer differs from a reference, say \"the posted solution disagrees; here's why mine differs\" and grade the learner against your own working. When a reference's numbers differ from the problem's own numbers, treat it as a likely transcription misread, never claim the author used wrong numbers. In every verdict, name the source you checked as a markdown link, or say no published solution was found online."
                : "The published solution references are checks, not the truth. A reference is a check, not the truth. If your worked answer differs from a reference, say \"the posted solution disagrees; here's why mine differs\" and grade the learner against your own working. When a reference's numbers differ from the problem's own numbers, treat it as a likely transcription misread, never claim the author used wrong numbers. In every verdict, name the source you checked as a markdown link.";
            if ((!input.reveal && !input.skip) || input.pset === undefined) {
              if (input.pset === undefined && input.unit === undefined) return item;
              return {
                ...item,
                text: yield* fs.readFileString(psetFile(path.join(root, course.id), number)),
                ...(references !== undefined ? { references } : {}),
                note: `References are hidden from the learner until their final answer; they are a check, not the truth. ${referencesNote}`,
              };
            }
            const text = yield* fs.readFileString(psetFile(path.join(root, course.id), number));
            const solution =
              pset.hasSolution &&
              (yield* fs.exists(psetFile(path.join(root, course.id), number, true)))
                ? yield* fs.readFileString(psetFile(path.join(root, course.id), number, true))
                : null;
            const examples = (pset.workedExampleUnits ?? [])
              .map((unit) => course.units[unit - 1]?.title)
              .filter(Boolean)
              .join(", ");
            return {
              ...item,
              text,
              solution,
              ...(references !== undefined ? { references } : {}),
              note: `${input.skip ? "The learner asked for the answer, so this problem is skipped; the visible reply must begin with the line **Skipped, not graded.**, then the final answer, then every step of the working. Name the reference checked as a markdown link, or say no published solution was found. Do not ask the learner to answer this part again. " : ""}${solution === null ? `No official solution exists; work the problem yourself and check against the listed worked-example units where they match (${examples || "none listed"}). Say plainly where your work disagrees. ` : ""}${referencesNote}`,
            };
          }),
        );
        const needsPublishedSearch =
          !input.reveal &&
          course.solutionSearchedAt === undefined &&
          selected.some((pset) => !pset.hasSolution && pset.references === undefined);
        return {
          ...attribution,
          problemSets: result,
          ...(needsPublishedSearch
            ? {
                note: `Do this now, before replying, without mentioning it: one web search for "${course.title} problem set solutions" (this single search is allowed; it is not a research pass), then course_prepare with units [${input.unit ?? course.position?.unit ?? 1}] and solutionLeads set to the free solution pages or PDFs it found ([] if none). Then assign the problem as usual.`,
              }
            : {}),
        };
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
    problems,
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
  problems: () => Effect.fail(failure("Courses are unavailable.")),
  update: () => Effect.fail(failure("Courses are unavailable.")),
  remove: () => Effect.fail(failure("Courses are unavailable.")),
  recordPrepThread: () => Effect.fail(failure("Courses are unavailable.")),
  clearCachedClips: Effect.fail(failure("Courses are unavailable.")),
  cachedConcepts: Effect.fail(failure("Courses are unavailable.")),
});
