import { isRuntimeModeAbove, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { HtmlPreviewToolkit, HtmlRenderToolkit, type HtmlToolkit } from "./tools.ts";

const INVALID_PAGE_ERRORS = new Set([
  "HtmlRenderFileError",
  "HtmlRenderFileTooLargeError",
  "HtmlRenderImagesNotFoundError",
  "HtmlRenderImageTooLargeError",
  "HtmlRenderPageTooLargeError",
  "HtmlRenderViewportHeightError",
]);

const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code:
      error._tag === "HtmlRenderLocalImagesDisallowedError"
        ? "capability_denied"
        : INVALID_PAGE_ERRORS.has(error._tag)
          ? "invalid_request"
          : "orchestration_error",
    message: error.message,
  });

// The server reads local files for the caller, so only a thread that reads files without asking
// may pass a path or have local image paths inlined; supervised threads pass inline HTML only.
const pageSource = Effect.fn("HtmlToolkit.pageSource")(function* (input: {
  readonly html?: string | undefined;
  readonly path?: string | undefined;
}) {
  const { limits, scope } = yield* loadCaller();
  const ceiling = scope.runtimeModeCeiling ?? "full-access";
  const allowLocalImages =
    limits.runtimeMode === "full-access" && !isRuntimeModeAbove("full-access", ceiling);
  if (input.html !== undefined && input.path === undefined) {
    return {
      source: { html: input.html } satisfies HtmlRender.HtmlRenderSource,
      allowLocalImages,
    };
  }
  if (input.path === undefined || input.html !== undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Pass exactly one of html or path.",
    });
  }
  if (!allowLocalImages) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Pass html instead of path: only full-access threads may pass a path.",
    });
  }
  return {
    source: { path: input.path } satisfies HtmlRender.HtmlRenderSource,
    allowLocalImages,
  };
});

const handlers = {
  // Local-file access limits this host browser to T3-launched agents.
  html_preview: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender.HtmlRender;
      const { source, allowLocalImages } = yield* pageSource(input);
      const { png, ...preview } = yield* htmlRender
        .preview({ ...source, allowLocalImages, width: input.width, appearance: input.appearance })
        .pipe(Effect.mapError(toFailure));
      return {
        ...preview,
        screenshot: {
          mimeType: "image/png" as const,
          data: png,
          width: preview.width,
          height: preview.capturedHeight,
        },
      };
    }),
  ),
  html_render: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "html_render");
      const htmlRender = yield* HtmlRender.HtmlRender;
      const { source, allowLocalImages } = yield* pageSource(input);
      const reference = yield* htmlRender
        .publish({
          ...source,
          allowLocalImages,
          threadId: thread.threadId,
          title: input.title,
          height: input.height,
        })
        .pipe(Effect.mapError(toFailure));
      return {
        htmlRender: reference,
        message:
          "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof HtmlToolkit.tools>;

export const layerPreview = McpToolAccess.toLayer(HtmlPreviewToolkit, {
  html_preview: handlers.html_preview,
});

export const layerRender = McpToolAccess.toLayer(HtmlRenderToolkit, {
  html_render: handlers.html_render,
});
