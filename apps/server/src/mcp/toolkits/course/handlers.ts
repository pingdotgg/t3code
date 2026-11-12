import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import * as CourseService from "../../../course/CourseService.ts";
import { CourseIngestError, ingestCourse } from "../../../course/ingest.ts";
import { CourseReferenceFetchError, fetchCourseReference } from "../../../course/referenceFetch.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { loadCaller } from "../../threadAccess.ts";
import { CourseReferenceToolkit, CourseToolkit } from "./tools.ts";

const PREP_BRIEF = `You are a course preparation thread. Work only on the requested units for course {{courseId}} (units: {{units}}). For each unit, call course_read with courseId and its unit number. Write 2–3 likely sticking points, ranked by what the unit needs that knowledge_map_read lacks, what the learner asked before, the transcript, and common misconceptions. Write a four-question quiz with answers first. Save both with course_update using courseId. Do not message, wake, or delegate into the lesson thread; this is background preparation.{{solutionLeads}}`;
const isCourseIngestError = Schema.is(CourseIngestError);
const isCourseReferenceFetchError = Schema.is(CourseReferenceFetchError);
const fail = (e: { readonly message: string }) =>
  new OrchestratorMcpFailure({
    code:
      isCourseIngestError(e) || isCourseReferenceFetchError(e)
        ? "invalid_request"
        : "orchestration_error",
    message: e.message,
  });
const atSeconds = (at: string | number | undefined) => {
  if (at === undefined) return undefined;
  if (typeof at === "number") return Number.isFinite(at) && at >= 0 ? at : undefined;
  const parts = at.split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return undefined;
  const seconds = parts.reduce((n, part) => n * 60 + Number(part), 0);
  return Number.isFinite(seconds) ? seconds : undefined;
};
const courseOwnershipFailure = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "That course belongs to another lesson.",
  });
const normalizeSolutionLeads = (raw: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
  const leads: string[] = [];
  for (const value of raw) {
    if (!URL.canParse(value)) return undefined;
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    leads.push(url.href);
  }
  return leads;
};
const getOwnedCourse = Effect.fn("course.getOwnedCourse")(function* (
  service: CourseService.CourseService["Service"],
  threadId: ThreadId,
  courseId: string | undefined,
) {
  const course = yield* service
    .get(courseId ? { id: courseId } : { lessonThreadId: threadId })
    .pipe(Effect.mapError(fail));
  if (!courseId || CourseService.courseBelongsToThread(course, threadId)) return course;
  // A lesson's side chats share its course.
  const { caller } = yield* loadCaller();
  if (caller?.sideChat?.lessonThreadId === course.lessonThreadId) return course;
  return yield* courseOwnershipFailure();
});
const courseReferenceFetchHandler = McpToolAccess.readsAsCaller(
  (input: Tool.Parameters<typeof CourseReferenceToolkit.tools.course_reference_fetch>) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(
        scope,
        "course_reference_fetch",
      );
      const service = yield* CourseService.CourseService;
      const course = yield* service.get({ id: input.courseId }).pipe(Effect.mapError(fail));
      if (!course.prepThreadIds.includes(thread.threadId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "course_reference_fetch is available only to this course's prep thread",
        });
      const config = yield* ServerConfig.ServerConfig;
      return yield* fetchCourseReference({
        url: input.url,
        ...(input.pages === undefined ? {} : { pages: input.pages }),
        audit: {
          stateDir: config.stateDir,
          threadId: thread.threadId,
          courseId: input.courseId,
        },
      }).pipe(Effect.mapError(fail));
    }),
);

const handlers = {
  course_add: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "course_add");
      const service = yield* CourseService.CourseService;
      if (!input.source) {
        if (!input.title || !input.units?.length)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "title and units are required when source is omitted",
          });
        return yield* service
          .add({ lessonThreadId: thread.threadId, title: input.title, units: input.units })
          .pipe(Effect.mapError(fail));
      }
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      // Only PDFs the learner attached: an agent in approval mode must not read host files through this tool.
      let source = input.source;
      if (!/^https?:/i.test(source)) {
        const real = yield* (yield* FileSystem.FileSystem)
          .realPath(source)
          .pipe(Effect.orElseSucceed(() => ""));
        const attachments = yield* (yield* FileSystem.FileSystem)
          .realPath(config.attachmentsDir)
          .pipe(Effect.orElseSucceed(() => config.attachmentsDir));
        if (!real.startsWith(attachments + path.sep))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A PDF must be attached to this chat; ask the learner to drop it in.",
          });
        source = real;
      }
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
        Effect.mapError(fail),
      );
      const ingested = yield* ingestCourse(source, {
        ytDlp: settings.courseYtDlp,
        workDir: path.join(config.stateDir, "courses", ".tmp"),
        // The course id comes from the downloaded course, so ingest lines name the lesson only.
        audit: { stateDir: config.stateDir, threadId: thread.threadId, courseId: null },
      }).pipe(Effect.mapError(fail));
      return yield* service
        .add({ lessonThreadId: thread.threadId, ingested })
        .pipe(Effect.mapError(fail));
    }),
  ),
  course_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "course_read");
      const service = yield* CourseService.CourseService;
      const course = yield* getOwnedCourse(service, thread.threadId, input.courseId);
      const cachedConcepts = yield* service.cachedConcepts.pipe(Effect.mapError(fail));
      if (input.unit === undefined) return { ...course, cachedConcepts };
      const at = atSeconds(input.at);
      if (input.at !== undefined && at === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "at must be seconds or a timestamp such as 23:10",
        });
      const unit = yield* service
        .readUnit({ courseId: course.id, unit: input.unit, ...(at === undefined ? {} : { at }) })
        .pipe(Effect.mapError(fail));
      // The clip decision happens on this read ("L4 23:10"), so it needs the cache too.
      return { ...unit, cachedConcepts };
    }),
  ),
  course_update: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "course_update");
      if (
        input.unit === undefined &&
        (input.plan !== undefined || input.quiz !== undefined || input.transcript !== undefined)
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "unit is required with plan, quiz or transcript",
        });
      const service = yield* CourseService.CourseService;
      const course = yield* getOwnedCourse(service, thread.threadId, input.courseId);
      return yield* service
        .update({
          courseId: course.id,
          ...(input.position ? { position: input.position } : {}),
          ...(input.unit === undefined ? {} : { unit: input.unit }),
          ...(input.plan === undefined ? {} : { plan: input.plan }),
          ...(input.quiz === undefined ? {} : { quiz: input.quiz }),
          ...(input.transcript === undefined ? {} : { transcript: input.transcript }),
          ...(input.pset === undefined ? {} : { pset: input.pset }),
          ...(input.references === undefined ? {} : { references: input.references }),
        })
        .pipe(Effect.mapError(fail));
    }),
  ),
  course_prepare: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "course_prepare");
      const service = yield* CourseService.CourseService;
      const course = yield* getOwnedCourse(service, thread.threadId, input.courseId);
      const solutionLeads = normalizeSolutionLeads([...new Set(input.solutionLeads ?? [])]);
      if (solutionLeads === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "solutionLeads must contain at most 10 http(s) URLs",
        });
      if (solutionLeads.length > 10)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "solutionLeads must contain at most 10 http(s) URLs",
        });
      const units = [...new Set(input.units)].sort((a, b) => a - b);
      if (units.length === 0 || units.some((unit) => unit < 1 || unit > course.units.length))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "units must name one or more course units",
        });
      if (input.solutionLeads !== undefined)
        yield* service
          .update({
            courseId: course.id,
            solutionSearchedAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.mapError(fail));
      if (input.solutionLeads !== undefined && solutionLeads.length === 0 && course.problemSets) {
        for (const [index, pset] of course.problemSets.entries()) {
          if (!pset.hasSolution && pset.references === undefined)
            yield* service
              .update({ courseId: course.id, pset: index + 1, references: [] })
              .pipe(Effect.mapError(fail));
        }
      }
      const first = units[0];
      const last = units[units.length - 1];
      const title = `Prep: ${course.title} L${first}–${last}`;
      const pendingSolutionPsets =
        input.solutionLeads !== undefined
          ? (course.problemSets ?? [])
              .map((pset, index) => ({ pset, number: index + 1 }))
              .filter(({ pset }) => !pset.hasSolution && pset.references === undefined)
          : [];
      const solutionBrief =
        solutionLeads.length > 0
          ? ` Problem sets to find solutions for: ${pendingSolutionPsets.map(({ number, pset }) => `${number} (${pset.title})`).join(", ") || "none"}. Open each solution lead with course_reference_fetch (follow index-page links to the matching named pset's solution file), read PDF page images, and for each problem record the given values exactly as read from the scan with page numbers. Compare them with the pset text from course_problems for that pset; when they differ, re-fetch that page with course_reference_fetch {pages} and read it again. If they still differ, write "values differ from the pset text (scan may be misread): …" in answers instead of silently using them. Transcribe each problem's final answers and key steps, and save them with course_update {pset, references} for each named pset you find. Save references [] for each named pset you do not find. Leads: ${solutionLeads.join(", ")}.`
          : "";
      const prompt = PREP_BRIEF.replace("{{courseId}}", course.id)
        .replace("{{units}}", units.join(", "))
        .replace("{{solutionLeads}}", solutionBrief);
      const clientRequestId = `course-prep:${course.id}:${DateTime.toEpochMillis(yield* DateTime.now)}`;
      // Recorded before the prep turn starts, so its first course_read is already allowed.
      yield* service
        .recordPrepThread(
          course.id,
          OrchestratorMcpService.stableThreadId({ scope, requestKey: clientRequestId, index: 0 }),
        )
        .pipe(Effect.mapError(fail));
      yield* (yield* OrchestratorMcpService.OrchestratorMcpService)
        .createThreads(scope, {
          clientRequestId,
          threads: [{ title, prompt, runtimeMode: "approval-required" }],
        })
        .pipe(Effect.mapError(fail));
      return { started: true, units };
    }),
  ),
  course_problems: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "course_problems");
      if (input.reveal && input.pset === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "pset is required with reveal",
        });
      if (input.skip && input.pset === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "pset is required with skip",
        });
      const service = yield* CourseService.CourseService;
      const course = yield* getOwnedCourse(service, thread.threadId, input.courseId);
      if (input.unit !== undefined && (input.unit < 1 || input.unit > course.units.length))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "unit must name a course unit",
        });
      return yield* service
        .problems({
          courseId: course.id,
          ...(input.unit === undefined ? {} : { unit: input.unit }),
          ...(input.pset === undefined ? {} : { pset: input.pset }),
          ...(input.reveal === undefined ? {} : { reveal: input.reveal }),
          ...(input.skip === undefined ? {} : { skip: input.skip }),
        })
        .pipe(Effect.mapError(fail));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof CourseToolkit.tools>;
export const layer = McpToolAccess.toLayer(CourseToolkit, handlers);
export const referenceLayer = McpToolAccess.toLayer(CourseReferenceToolkit, {
  course_reference_fetch: courseReferenceFetchHandler,
});
