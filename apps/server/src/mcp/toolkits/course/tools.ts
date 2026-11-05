import { Course, OrchestratorMcpFailure } from "@t3tools/contracts";
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
    Path.Path,
  ],
}).annotate(Tool.Title, "Add course");
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
}).annotate(Tool.Title, "Read course");
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
}).annotate(Tool.Title, "Update course");
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
export const CourseToolkit = Toolkit.make(
  CourseAddTool,
  CourseReadTool,
  CourseUpdateTool,
  CoursePrepareTool,
);
