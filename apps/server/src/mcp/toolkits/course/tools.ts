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
  description: "Update course position, a unit's plan, quiz, or pasted transcript.",
  parameters: Schema.Struct({
    position: Schema.optional(
      Schema.Struct({ unit: Schema.Int, at: Schema.optional(Schema.Number) }),
    ),
    unit: Schema.optional(Schema.Int),
    plan: Schema.optional(Schema.String),
    quiz: Schema.optional(Schema.String),
    transcript: Schema.optional(Schema.String),
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
    "Assign and grade a course problem set. With unit, list that unit's section problem sets; with pset, return its problem text. Without either, list all sets. Problem text is visible without reveal, but never call reveal or state an answer until the learner has given a final answer. On request, give one smallest-next-step hint at a time and never the final value. With reveal and pset, return the official solution when present; otherwise say no official solution exists, use the listed worked examples, and say plainly: graded against my own worked solution, not MIT's. Include the course attribution in every result.",
  parameters: Schema.Struct({
    unit: Schema.optional(Schema.Int),
    pset: Schema.optional(Schema.Int),
    reveal: Schema.optional(Schema.Boolean),
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
export const CourseToolkit = Toolkit.make(
  CourseAddTool,
  CourseReadTool,
  CourseUpdateTool,
  CoursePrepareTool,
  CourseProblemsTool,
);
