import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as ServerConfig from "../../../config.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as WorkspaceFolders from "../../../workspace/WorkspaceFolders.ts";
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
      error._tag === "HtmlRenderImagesOutsideRootsError"
        ? "capability_denied"
        : INVALID_PAGE_ERRORS.has(error._tag)
          ? "invalid_request"
          : "orchestration_error",
    message: error.message,
  });

const handlers = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
  const config = yield* ServerConfig.ServerConfig;

  // The server reads files for the caller, so only a thread that reads files without asking may
  // pass a path or inline any local image. A supervised thread's images must sit where its provider
  // reads without asking: its cwd and the folders it is granted, or T3's own attachments and
  // screenshots.
  const pageSource = Effect.fn("HtmlToolkit.pageSource")(function* (input: {
    readonly html?: string | undefined;
    readonly path?: string | undefined;
  }) {
    const source: HtmlRender.HtmlRenderSource | undefined =
      input.html !== undefined && input.path === undefined
        ? { html: input.html }
        : input.path !== undefined && input.html === undefined
          ? { path: input.path }
          : undefined;
    if (source === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Pass exactly one of html or path.",
      });
    }
    // Inline HTML still renders when the caller cannot be read; it just gets no workspace.
    const loaded = yield* Effect.result(loadCaller());
    const scope = yield* McpInvocationContext.McpInvocationContext;
    // A thread recorded above an administrator's ceiling does not hold full access.
    const fullAccess =
      Result.isSuccess(loaded) &&
      loaded.success.limits.runtimeMode === "full-access" &&
      (scope.runtimeModeCeiling ?? "full-access") === "full-access";
    if (fullAccess) return source;
    if ("path" in source) {
      if (Result.isFailure(loaded)) return yield* loaded.failure;
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Pass html instead of path: only full-access threads may pass a path.",
      });
    }
    const caller = Result.isSuccess(loaded) ? loaded.success.caller : undefined;
    const project =
      caller === undefined
        ? Option.none()
        : yield* projects.getById(caller.projectId).pipe(Effect.orElseSucceed(Option.none));
    const cwd = caller?.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
    const granted =
      caller === undefined
        ? []
        : ((yield* workspaceFolders
            .forThread({ projectId: caller.projectId, worktreePath: caller.worktreePath })
            .pipe(Effect.orElseSucceed(() => undefined)))?.extraRoots ?? []);
    return {
      html: source.html,
      imageRoots: [
        ...(cwd === undefined ? [] : [cwd]),
        ...granted,
        config.attachmentsDir,
        config.browserArtifactsDir,
      ],
    } satisfies HtmlRender.HtmlRenderSource & HtmlRender.HtmlRenderImageAccess;
  });

  return {
    // Local-file access limits this host browser to T3-launched agents.
    html_preview: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const htmlRender = yield* HtmlRender.HtmlRender;
        const source = yield* pageSource(input);
        const { png, ...preview } = yield* htmlRender
          .preview({ ...source, width: input.width, appearance: input.appearance })
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
        const source = yield* pageSource(input);
        const reference = yield* htmlRender
          .publish({
            ...source,
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
});

export const layerPreview = McpToolAccess.toLayer(
  HtmlPreviewToolkit,
  Effect.map(handlers, ({ html_preview }) => ({ html_preview })),
);

export const layerRender = McpToolAccess.toLayer(
  HtmlRenderToolkit,
  Effect.map(handlers, ({ html_render }) => ({ html_render })),
);
