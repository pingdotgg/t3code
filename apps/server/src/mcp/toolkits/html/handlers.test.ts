import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { resolveAttachmentPathById } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewBrowser from "../../../preview/PreviewBrowser.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { layerPreview, layerRender } from "./handlers.ts";
import { HtmlPreviewToolkit, HtmlRenderToolkit } from "./tools.ts";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:html-handlers"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});

it.effect.each([
  {
    label: "approval-required thread",
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    expectsInlined: false,
  },
  {
    label: "plan-mode supervised thread",
    runtimeMode: "approval-required" as const,
    interactionMode: "plan" as const,
    expectsInlined: false,
  },
  {
    label: "full-access thread",
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    expectsInlined: true,
  },
])(
  "html_render with inline html for $label (inlines local images=$expectsInlined)",
  ({ runtimeMode, interactionMode, expectsInlined }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-html-handler-render-",
      });
      const png = path.join(directory, "private.png");
      yield* fileSystem.writeFile(png, PNG_BYTES);

      const toolkit = yield* HtmlRenderToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(layerRender)),
      );
      const results = yield* toolkit
        .handle("html_render", {
          html: `<img src="${png}">`,
          title: "Greendale Diagram",
          height: 300,
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      const result = results.at(-1)?.result as {
        readonly htmlRender: { readonly attachmentId: string };
      };
      const storedPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: result.htmlRender.attachmentId,
      });
      const storedHtml = yield* fileSystem.readFileString(storedPath ?? "");
      expect(storedHtml.includes("data:image/png;base64,")).toBe(expectsInlined);
    }).pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        threadScope(ThreadId.make(`thread:html-render:${runtimeMode}:${interactionMode}`)),
      ),
      Effect.provide(
        Layer.mergeAll(
          HtmlRender.layer.pipe(
            Layer.provide(
              Layer.succeed(
                PreviewBrowser.PreviewBrowser,
                PreviewBrowser.PreviewBrowser.of({
                  executable: Effect.die("unused"),
                  installed: Effect.succeedNone,
                }),
              ),
            ),
          ),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(liveThreadShell(threadId, { runtimeMode, interactionMode })),
          }),
        ).pipe(
          Layer.provideMerge(McpProviderSessions.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-html-handler-test-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect.each([
  {
    label: "approval-required thread",
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    expectedAllowLocalImages: false,
  },
  {
    label: "plan-mode supervised thread",
    runtimeMode: "approval-required" as const,
    interactionMode: "plan" as const,
    expectedAllowLocalImages: false,
  },
  {
    label: "full-access thread",
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    expectedAllowLocalImages: true,
  },
])(
  "html_preview passes allowLocalImages=$expectedAllowLocalImages for $label",
  ({ runtimeMode, interactionMode, expectedAllowLocalImages }) => {
    const received: Array<{ readonly allowLocalImages?: boolean | undefined }> = [];
    return Effect.gen(function* () {
      const toolkit = yield* HtmlPreviewToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(layerPreview)),
      );
      yield* toolkit
        .handle("html_preview", { html: '<img src="/outside/private.png">' })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(received).toEqual([{ allowLocalImages: expectedAllowLocalImages }]);
    }).pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        threadScope(ThreadId.make(`thread:html-preview:${runtimeMode}:${interactionMode}`)),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(HtmlRender.HtmlRender)({
            preview: (input) =>
              Effect.sync(() => {
                received.push({ allowLocalImages: input.allowLocalImages });
                return {
                  png: "iVBORw0KGgo=",
                  width: 600,
                  contentHeight: 200,
                  capturedHeight: 200,
                  consoleMessages: [],
                };
              }),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(liveThreadShell(threadId, { runtimeMode, interactionMode })),
          }),
        ),
      ),
    );
  },
);
