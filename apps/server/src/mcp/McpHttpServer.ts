import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { PNG } from "pngjs";

import packageJson from "../../package.json" with { type: "json" };
import type { McpAuthError } from "@t3tools/contracts";
import { enforceFinalSnapshotTextBudget } from "@t3tools/shared/previewAutomationBudgets";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { resolveBrowserEvidenceDir, saveBrowserEvidenceFile } from "./PreviewEvidence.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewOpenAndSnapshotTool,
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { PullRequestMonitorToolkitHandlersLive } from "./toolkits/pullRequestMonitor/handlers.ts";
import { PullRequestMonitorToolkit } from "./toolkits/pullRequestMonitor/tools.ts";
import { CollaborativeAcceptanceToolkitHandlersLive } from "./toolkits/collaborativeAcceptance/handlers.ts";
import { CollaborativeAcceptanceToolkit } from "./toolkits/collaborativeAcceptance/tools.ts";
import * as DeviceService from "../device/DeviceService.ts";
import {
  DeviceScreenshotToolkitHandlersLive,
  DeviceStandardToolkitHandlersLive,
} from "./toolkits/device/handlers.ts";
import {
  DeviceScreenshotTool,
  DeviceScreenshotToolkit,
  DeviceStandardToolkit,
} from "./toolkits/device/tools.ts";

export const invalidMcpCredentialBody = {
  error: "invalid_mcp_credential",
  recovery: "reconnect-required",
  message:
    "The T3 Code MCP session credential is invalid or expired. Restart the chat/session to reconnect browser automation.",
} as const satisfies McpAuthError;

export const invalidMcpCredentialResponse = HttpServerResponse.jsonUnsafe(
  {
    ...invalidMcpCredentialBody,
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const filterAdvertisedTools = (
  response: HttpServerResponse.HttpServerResponse,
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): HttpServerResponse.HttpServerResponse => {
  if (response.body._tag !== "Uint8Array") return response;
  try {
    const payload = JSON.parse(new TextDecoder().decode(response.body.body)) as {
      readonly result?: { readonly tools?: ReadonlyArray<{ readonly name?: string }> };
    };
    if (!payload.result?.tools) return response;
    return HttpServerResponse.jsonUnsafe(
      {
        ...payload,
        result: {
          ...payload.result,
          tools: payload.result.tools.filter(
            (tool) =>
              (capabilities.has("device") || !tool.name?.startsWith("device_")) &&
              (capabilities.has("preview") || !tool.name?.startsWith("preview_")),
          ),
        },
      },
      { status: response.status, headers: response.headers },
    );
  } catch {
    return response;
  }
};

export const filterAdvertisedToolsForTest = filterAdvertisedTools;

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map(
    (registry): McpAuthMiddleware =>
      Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const invocation = yield* registry.resolve(token);
        if (!invocation) {
          yield* Effect.logWarning("rejected MCP request with an unusable credential", {
            reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
          });
          return invalidMcpCredentialResponse;
        }
        return yield* httpEffect.pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.map((response) => filterAdvertisedTools(response, invocation.capabilities)),
          Effect.map(normalizeMcpHttpResponse),
        );
      }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewAutomationError";
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
      },
    },
    content: [{ type: "text", text: "Preview snapshot failed." }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

export interface PreviewSnapshotEncodeOptions {
  /** Persist the screenshot as server-side evidence and return its screenshotPath. */
  readonly save?: boolean | undefined;
  /** Explicit evidence directory (tests). Defaults to the shared evidence dir. */
  readonly evidenceDir?: string | undefined;
}

export const encodePreviewSnapshotResult = async (
  encodedResult: unknown,
  options?: PreviewSnapshotEncodeOptions,
) => {
  const snapshot = encodedResult as {
    readonly screenshot: {
      readonly mimeType: "image/png";
      readonly data: string;
      readonly width: number;
      readonly height: number;
    };
    readonly screenshotCaptureFailure?: {
      readonly _tag: "PreviewScreenshotCaptureFailed";
      readonly operation: "Page.captureScreenshot";
    };
    readonly [key: string]: unknown;
  };
  // A host-provided screenshotPath is never trusted: only the path returned
  // by saveBrowserEvidenceFile below is presented as server-persisted evidence.
  const { screenshot, screenshotPath: _hostScreenshotPath, ...page } = snapshot;
  const bytes = Buffer.from(screenshot.data, "base64");
  const boundedPng =
    screenshot.width > 0 &&
    screenshot.height > 0 &&
    screenshot.width <= 3840 &&
    screenshot.height <= 3840 &&
    bytes.length >= 45 &&
    bytes.length <= 64 * 1024 * 1024 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) === screenshot.width &&
    bytes.readUInt32BE(20) === screenshot.height &&
    bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
  const decoded = boundedPng
    ? await new Promise<PNG | null>((resolve) => {
        const decoder = new PNG({ checkCRC: true });
        decoder.on("metadata", (image) => {
          if (image.width !== screenshot.width || image.height !== screenshot.height) {
            decoder.destroy();
            resolve(null);
          }
        });
        decoder.parse(bytes, (error, image) => {
          resolve(error ? null : image);
        });
      })
    : null;
  const metadata = {
    ...page,
    screenshot: {
      mimeType: screenshot.mimeType,
      width: screenshot.width,
      height: screenshot.height,
    },
  };
  const screenshotCaptureFailure = snapshot.screenshotCaptureFailure
    ? {
        ...snapshot.screenshotCaptureFailure,
        message:
          "The browser could not capture a screenshot. Page text is diagnostic only; visual validation did not pass.",
      }
    : null;
  if (
    screenshotCaptureFailure ||
    !decoded ||
    decoded.width !== screenshot.width ||
    decoded.height !== screenshot.height ||
    decoded.data.length !== screenshot.width * screenshot.height * 4
  ) {
    // Budget the exact payloads returned below, after their error fields are
    // appended, so neither can exceed the ceiling.
    const structured = enforceFinalSnapshotTextBudget({
      ...metadata,
      error: screenshotCaptureFailure ?? {
        _tag: "PreviewScreenshotInvalid",
        operation: "snapshot",
        message:
          "The browser returned an empty, oversized, or undecodable screenshot. Page text is diagnostic only; visual validation did not pass. Reveal the browser, wait for rendering, and retry the snapshot.",
      },
    });
    const textPayload = enforceFinalSnapshotTextBudget({
      ...metadata,
      error:
        "Visual capture failed. Reveal the browser and retry; do not publish this capture as evidence.",
    });
    return new McpSchema.CallToolResult({
      isError: true,
      structuredContent: structured,
      content: [
        {
          type: "text",
          text: JSON.stringify(textPayload),
        },
      ],
    });
  }
  let screenshotPath: string | undefined;
  if (options?.save === true) {
    try {
      screenshotPath = await saveBrowserEvidenceFile({
        directory: resolveBrowserEvidenceDir(options.evidenceDir),
        prefix: "preview-snapshot",
        extension: "png",
        bytes,
      });
    } catch {
      screenshotPath = undefined;
    }
  }
  const budgeted = enforceFinalSnapshotTextBudget({
    ...metadata,
    ...(screenshotPath === undefined ? {} : { screenshotPath }),
  });
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: budgeted,
    content: [
      { type: "text", text: JSON.stringify(budgeted) },
      {
        type: "image",
        data: new Uint8Array(bytes),
        mimeType: screenshot.mimeType,
      },
    ],
  });
};

const registerPreviewSnapshotTool = Effect.fn("McpHttpServer.registerPreviewSnapshotTool")(
  function* (
    tool: typeof PreviewSnapshotTool | typeof PreviewOpenAndSnapshotTool,
    handleName: "preview_snapshot" | "preview_open_and_snapshot",
  ) {
    const server = yield* McpServer.McpServer;
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const built = yield* PreviewSnapshotToolkit;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          return built.handle(handleName, payload).pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.matchCauseEffect({
              onFailure: previewSnapshotFailure,
              onSuccess: ({ encodedResult }) =>
                Effect.promise(() =>
                  encodePreviewSnapshotResult(encodedResult, {
                    save: (payload as { readonly save?: boolean }).save === true,
                  }),
                ),
            }),
          );
        }),
    });
  },
);

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  yield* registerPreviewSnapshotTool(PreviewSnapshotTool, "preview_snapshot");
  yield* registerPreviewSnapshotTool(PreviewOpenAndSnapshotTool, "preview_open_and_snapshot");
});

interface ImageToolResult {
  readonly screenshot: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly [key: string]: unknown;
}

/**
 * Failures surface only their tag: the remote message may carry renderer or
 * device output the agent should not see, and the tag is what it can act on.
 */
const imageToolFailure =
  (toolName: string, operation: string, failureText: string) =>
  <E>(cause: Cause.Cause<E>) => {
    if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
      return Effect.failCause(cause).pipe(Effect.orDie);
    }
    const failures = cause.reasons.filter(Cause.isFailReason);
    const firstFailure = failures[0]?.error;
    const errorTag =
      typeof firstFailure === "object" &&
      firstFailure !== null &&
      "_tag" in firstFailure &&
      typeof firstFailure._tag === "string"
        ? firstFailure._tag
        : `${toolName}Error`;
    const result = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: {
        error: {
          _tag: errorTag,
          operation,
          failureCount: failures.length,
        },
      },
      content: [{ type: "text", text: failureText }],
    });
    return Effect.logWarning(`${toolName} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

/**
 * `McpServer.toolkit` serializes every result as JSON text, which is the
 * wrong shape for a screenshot: the model needs image content. Tools whose
 * result carries a `screenshot` field are registered by hand so the PNG goes
 * out as an image block and the rest of the payload as JSON metadata.
 */
const registerImageTool = <T extends Tool.Any, E, R>(
  tool: T,
  handle: (payload: Tool.Parameters<T>) => Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  provide: (
    effect: Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  ) => Effect.Effect<
    { readonly encodedResult: unknown },
    E,
    McpInvocationContext.McpInvocationContext
  >,
  operation: string,
  failureText: string,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          return provide(handle(payload as Tool.Parameters<T>)).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.matchCauseEffect({
              onFailure: imageToolFailure(tool.name, operation, failureText),
              onSuccess: ({ encodedResult }) => {
                const { screenshot, ...rest } = encodedResult as ImageToolResult;
                const includeImage =
                  (payload as { readonly includeImage?: boolean } | undefined)?.includeImage !==
                  false;
                const metadata = {
                  ...rest,
                  screenshot: {
                    mimeType: screenshot.mimeType,
                    width: screenshot.width,
                    height: screenshot.height,
                  },
                };
                return Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent: metadata,
                    content: [
                      { type: "text", text: JSON.stringify(metadata) },
                      ...(includeImage
                        ? [
                            {
                              type: "image" as const,
                              data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                              mimeType: screenshot.mimeType,
                            },
                          ]
                        : []),
                    ],
                  }),
                );
              },
            }),
          );
        }),
    });
  });

const registerDeviceScreenshot = Effect.fn("McpHttpServer.registerDeviceScreenshot")(function* () {
  const devices = yield* DeviceService.DeviceService;
  const built = yield* DeviceScreenshotToolkit;
  yield* registerImageTool(
    DeviceScreenshotTool,
    (payload) =>
      built
        .handle("device_screenshot", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) => effect.pipe(Effect.provideService(DeviceService.DeviceService, devices)),
    "screenshot",
    "Device screenshot failed.",
  );
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

/**
 * Durable pull request monitor tools. Their thread identity comes from the same per-session
 * credential the transport already resolves, so agents cannot address another chat's monitor.
 */
export const PullRequestMonitorToolkitRegistrationLive = McpServer.toolkit(
  PullRequestMonitorToolkit,
).pipe(Layer.provide(PullRequestMonitorToolkitHandlersLive));

export const CollaborativeAcceptanceToolkitRegistrationLive = McpServer.toolkit(
  CollaborativeAcceptanceToolkit,
).pipe(Layer.provide(CollaborativeAcceptanceToolkitHandlersLive));

const DeviceStandardToolkitRegistrationLive = McpServer.toolkit(DeviceStandardToolkit).pipe(
  Layer.provide(DeviceStandardToolkitHandlersLive),
);

const DeviceScreenshotRegistrationLive = Layer.effectDiscard(registerDeviceScreenshot()).pipe(
  Layer.provide(DeviceScreenshotToolkitHandlersLive),
);

export const DeviceToolkitRegistrationLive = Layer.mergeAll(
  DeviceStandardToolkitRegistrationLive,
  DeviceScreenshotRegistrationLive,
);

const mcpTransport = (path: "/mcp" | "/mcp-device") =>
  McpServer.layerHttp({
    name: "T3 Code",
    version: packageJson.version,
    path,
  }).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  PullRequestMonitorToolkitRegistrationLive,
  CollaborativeAcceptanceToolkitRegistrationLive,
).pipe(Layer.provideMerge(mcpTransport("/mcp")));

export const layerWithDevice = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  PullRequestMonitorToolkitRegistrationLive,
  CollaborativeAcceptanceToolkitRegistrationLive,
  DeviceToolkitRegistrationLive,
).pipe(Layer.provideMerge(mcpTransport("/mcp-device")));
