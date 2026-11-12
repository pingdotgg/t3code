import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  ANIMATION_RENDER_TOOL_NAME,
  HTML_RENDER_MAX_TITLE_LENGTH,
} from "@t3tools/shared/htmlRender";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ManimRender from "../../../animation/ManimRender.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../../../config.ts";
import * as CourseService from "../../../course/CourseService.ts";
import { CourseId } from "../course/tools.ts";

const AnimationRenderTool = Tool.make(ANIMATION_RENDER_TOOL_NAME, {
  description:
    "Render a short ManimCE clip and show it inline in this thread. `code` is a full Python file with `class Lesson(Scene)`, 10 to 25 s, 3Blue1Brown style, no external files or sound; code needs a full-access thread in default mode. Use when motion teaches; skip after 2 failures too. In a course lesson, first check `course_read`'s `cachedConcepts`: pass a fitting `concept` with no `code` to show that prepared clip at once; pass `concept` with `code` to save a new one.",
  parameters: Schema.Struct({
    code: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64 * 1024)),
    ),
    concept: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
    courseId: Schema.optional(CourseId),
    title: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH),
    ),
    forCard: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
        description:
          "In a lesson, id from the learner's `(card <id>)` answer when this picture answers that card.",
      }),
    ),
  }).check(
    Schema.makeFilter((input) => input.code !== undefined || input.concept !== undefined, {
      expected: "code or concept",
    }),
  ),
  success: Schema.Struct({
    htmlRender: Schema.Struct({
      attachmentId: Schema.String,
      title: Schema.String,
      height: Schema.Number,
      heights: Schema.optional(Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))),
      forCard: Schema.optional(Schema.String),
    }),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HtmlRender.HtmlRender,
    ManimRender.ManimRender,
    FileSystem.FileSystem,
    Path.Path,
    ServerConfig.ServerConfig,
    CourseService.CourseService,
  ],
})
  .annotate(Tool.Title, "Render animation")
  // It runs agent-written Python on the server, so providers must gate it like a shell command.
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const AnimationToolkit = Toolkit.make(AnimationRenderTool);
