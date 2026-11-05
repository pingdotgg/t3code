import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { HTML_RENDER_COLUMN_WIDTH } from "@t3tools/shared/htmlRender";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ManimRender from "../../../animation/ManimRender.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AnimationToolkit } from "./tools.ts";

const INVALID_REQUEST_ERRORS = new Set([
  "ManimUnavailableError",
  "ManimFailedError",
  "ManimClipTooLargeError",
  "HtmlRenderImagesNotFoundError",
  "HtmlRenderImageTooLargeError",
  "HtmlRenderPageTooLargeError",
  "HtmlRenderViewportHeightError",
]);

const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: INVALID_REQUEST_ERRORS.has(error._tag) ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const handlers = {
  animation_render: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "animation_render");
      const manim = yield* ManimRender.ManimRender;
      const clip = yield* manim.render(input.code).pipe(Effect.mapError(toFailure));
      const html = `<html><body style="margin:0;background:#0b0b0f"><video src="data:video/mp4;base64,${Base64.encode(clip)}" autoplay muted loop playsinline controls style="width:100%;display:block"></video></body></html>`;
      const htmlRenderService = yield* HtmlRender.HtmlRender;
      const htmlRender = yield* htmlRenderService
        .publish({
          threadId: thread.threadId,
          html,
          title: input.title,
          height: Math.round((HTML_RENDER_COLUMN_WIDTH * 480) / 854) + 8,
        })
        .pipe(Effect.mapError(toFailure));
      return {
        htmlRender,
        message: "Shown to the reader above your reply. Don't describe the clip.",
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof AnimationToolkit.tools>;

export const layer = McpToolAccess.toLayer(AnimationToolkit, handlers);
