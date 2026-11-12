import { Course, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as CourseService from "../../../course/CourseService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";

export const CourseId = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));

const CourseAddTool = Tool.make("course_add", {
  description:
    "Add a course from an OCW/YouTube URL or absolute PDF path, or create an own course from unit titles. Links it to this lesson.",
  parameters: Schema.Struct({
    source: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    units: Schema.optional(Schema.Array(Schema.String)),
  }),
  success: Course,
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    CourseService.CourseService,
    ServerConfig.ServerConfig,
    ServerSettings.ServerSettingsService,
    ThreadManagementService.ThreadManagementService,
    ProcessRunner.ProcessRunner,
    FileSystem.FileSystem,
    Path.Path,
  ],
})
  .annotate(Tool.Title, "Add course")
  // Downloads from OCW/YouTube and reads an attached PDF.
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const CourseReadTool = Tool.make("course_read", {
  description:
    "Read the linked course outline or one unit's plan, quiz, and a small transcript window.",
  parameters: Schema.Struct({
    unit: Schema.optional(Schema.Int),
    at: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    courseId: Schema.optional(CourseId),
  }),
  success: Schema.Unknown,
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    CourseService.CourseService,
    ThreadManagementService.ThreadManagementService,
    ProcessRunner.ProcessRunner,
  ],
})
  .annotate(Tool.Title, "Read course")
  // Codex in approval-required asks before any T3 tool without these hints, which stalls prep threads.
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const CourseUpdateTool = Tool.make("course_update", {
  description:
    "Update course position, a unit's plan, quiz, or pasted transcript; save published problem-set references with pset and references.",
  parameters: Schema.Struct({
    position: Schema.optional(
      Schema.Struct({ unit: Schema.Int, at: Schema.optional(Schema.Number) }),
    ),
    unit: Schema.optional(Schema.Int),
    plan: Schema.optional(Schema.String),
    quiz: Schema.optional(Schema.String),
    transcript: Schema.optional(Schema.String),
    pset: Schema.optional(Schema.Int),
    references: Schema.optional(
      Schema.Array(
        Schema.Struct({ label: Schema.String, url: Schema.String, answers: Schema.String }),
      ),
    ),
    courseId: Schema.optional(CourseId),
  }),
  success: Course,
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    CourseService.CourseService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Update course")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const CoursePrepareTool = Tool.make("course_prepare", {
  description:
    "Prepare selected course units in a background prep thread. It never posts into the lesson thread.",
  parameters: Schema.Struct({
    units: Schema.Array(Schema.Int),
    solutionLeads: Schema.optional(Schema.Array(Schema.String)),
    courseId: Schema.optional(CourseId),
  }),
  success: Schema.Struct({ started: Schema.Boolean, units: Schema.Array(Schema.Int) }),
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    CourseService.CourseService,
    ThreadManagementService.ThreadManagementService,
    OrchestratorMcpService.OrchestratorMcpService,
  ],
}).annotate(Tool.Title, "Prepare course");
const CourseProblemsTool = Tool.make("course_problems", {
  description:
    "Assign or grade course problems. Use pset for one set; use skip with pset when the learner asks for the answer, then follow its working and citation note. Use reveal with pset after an answer. Include attribution and cite saved references in verdicts.",
  parameters: Schema.Struct({
    unit: Schema.optional(Schema.Int),
    pset: Schema.optional(Schema.Int),
    reveal: Schema.optional(Schema.Boolean),
    skip: Schema.optional(Schema.Boolean),
    courseId: Schema.optional(CourseId),
  }),
  success: Schema.Unknown,
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    CourseService.CourseService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Course problems")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const CourseReferenceFetchTool = Tool.make("course_reference_fetch", {
  description:
    "Fetch a public HTML or PDF solution reference. PDF results include text and readable page images for up to four requested pages.",
  parameters: Schema.Struct({
    url: Schema.String,
    pages: Schema.optional(Schema.Array(Schema.Int)),
    courseId: CourseId,
  }),
  success: Schema.Unknown,
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    CourseService.CourseService,
    ServerConfig.ServerConfig,
  ],
})
  .annotate(Tool.Title, "Fetch course reference")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
export const CourseToolkit = Toolkit.make(
  CourseAddTool,
  CourseReadTool,
  CourseUpdateTool,
  CoursePrepareTool,
  CourseProblemsTool,
);
export const CourseReferenceToolkit = Toolkit.make(CourseReferenceFetchTool);
