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

const AnimationRenderTool = Tool.make(ANIMATION_RENDER_TOOL_NAME, {
  description:
    "Render a short ManimCE clip and show it inline in this thread. `code` is a full Python file with `class Lesson(Scene)`, 10 to 25 s, 3Blue1Brown style, no external files or sound. Use only when motion teaches something; if Manim is missing or rendering fails twice, skip the clip.",
  parameters: Schema.Struct({
    code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64 * 1024)),
    title: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH),
    ),
  }),
  success: Schema.Struct({
    htmlRender: Schema.Struct({
      attachmentId: Schema.String,
      title: Schema.String,
      height: Schema.Number,
      heights: Schema.optional(Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))),
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
  ],
})
  .annotate(Tool.Title, "Render animation")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const AnimationToolkit = Toolkit.make(AnimationRenderTool);
