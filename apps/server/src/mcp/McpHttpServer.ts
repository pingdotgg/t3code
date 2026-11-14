import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { AiError, McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  DeviceToolError,
  OrchestratorMcpFailure,
  PreviewAutomationError,
  ProviderInteractionMode,
  type RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

import packageJson from "../../package.json" with { type: "json" };
import { parseBearerToken } from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import {
  type AgentThread,
  agentToolProperties,
  handoffSettings,
  MAX_REPORTED_DEPTH,
  toolOutcome,
} from "../telemetry/ProviderDimensions.ts";
import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import * as PreviewControlsHandlers from "./toolkits/previewControls/handlers.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import * as EnvironmentHandlers from "./toolkits/environment/handlers.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import * as AttachmentHandlers from "./toolkits/attachment/handlers.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import * as ThreadHandlers from "./toolkits/thread/handlers.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as PreviewHandlers from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import * as WorktreeHandlers from "./toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
import * as PullRequestsHandlers from "./toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import * as DeviceHandlers from "./toolkits/device/handlers.ts";
import {
  DeviceScreenshotTool,
  DeviceScreenshotToolkit,
  DeviceStandardToolkit,
} from "./toolkits/device/tools.ts";
import * as HtmlHandlers from "./toolkits/html/handlers.ts";
import { HtmlPreviewTool, HtmlPreviewToolkit, HtmlRenderToolkit } from "./toolkits/html/tools.ts";
import { requestUrl } from "../requestUrl.ts";
import { withToolAnalytics } from "./McpHttpServerParts.ts";
import { boundSnapshotMetadata } from "./McpHttpServerParts2.ts";
import { registerPreviewSnapshot } from "./McpHttpServerParts3.ts";
import { registerImageTool } from "./McpHttpServerParts4.ts";

const mcpResourceMetadataUrl = (request: HttpServerRequest.HttpServerRequest) =>
  requestUrl(request).pipe(
    Option.map((url) => `${url.origin}/.well-known/oauth-protected-resource/mcp`),
  );

/** Launched agents cannot open OAuth browsers; OAuth would mint credentials outliving their session. */
const unauthorized = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly presentedToken: boolean;
  readonly offerOAuth: boolean;
}) => {
  const metadataUrl = input.offerOAuth
    ? Option.getOrUndefined(mcpResourceMetadataUrl(input.request))
    : undefined;
  const challenge = [
    "Bearer",
    [
      ...(metadataUrl === undefined ? [] : [`resource_metadata="${metadataUrl}"`]),
      ...(input.presentedToken ? ['error="invalid_token"'] : []),
    ].join(", "),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return HttpServerResponse.jsonUnsafe(
    {
      error: "invalid_mcp_credential",
      message: "A valid T3 Code MCP credential is required.",
    },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": challenge,
      },
    },
  );
};

export class McpClientAuthenticator extends Context.Service<
  McpClientAuthenticator,
  {
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  }
>()("t3/mcp/McpHttpServer/McpClientAuthenticator") {}

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

const normalizeMcpHttpResponse = (
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

// Session tokens are `<payload>.<signature>`; registry tokens are a bare base64url secret.
const looksLikeProviderToken = (token: string) => token.length > 0 && !token.includes(".");

const decodeModeLimit = Schema.decodeUnknownOption(
  Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
);
const parseModeLimit = (value: string) => {
  const [runtimeMode, interactionMode, ...rest] = value.trim().split("/");
  return rest.length === 0 ? decodeModeLimit({ runtimeMode, interactionMode }) : Option.none();
};

const invalidModeLimit = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mode_limit",
    message: "T3-Mode-Limit must be <runtimeMode>/<interactionMode>, e.g. auto/default.",
  },
  { status: 400, headers: { "cache-control": "no-store" } },
);

/** Applies a client's requested mode limit; undefined when the header is malformed. */
const withModeLimit = (
  invocation: McpInvocationContext.McpInvocationScope,
  request: HttpServerRequest.HttpServerRequest,
): McpInvocationContext.McpInvocationScope | undefined => {
  const header = request.headers[McpInvocationContext.MODE_LIMIT_HEADER];
  if (header === undefined || invocation.client === undefined) return invocation;
  const limit = parseModeLimit(header);
  return Option.isNone(limit)
    ? undefined
    : { ...invocation, client: { ...invocation.client, narrowedTo: limit.value } };
};

// The Linked environments beta is off here: links wait until it is on again.
const linkedEnvironmentsOff = HttpServerResponse.jsonUnsafe(
  {
    error: "linked_environments_off",
    message: "Linked environments is off on this machine. Turn it on in its Settings → Labs.",
  },
  { status: 403, headers: { "cache-control": "no-store" } },
);

const makeMcpAuthMiddleware = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const clients = yield* Effect.serviceOption(McpClientAuthenticator);
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const runtimeModeCeiling = serverSettings.managedPolicy?.limits?.maxRuntimeMode;
  const linksEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );
  return Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    const token = parseBearerToken(request) ?? "";
    const invocation =
      (yield* registry.resolve(token)) ??
      (Option.isSome(clients) && token.length > 0
        ? yield* clients.value.authenticate(request)
        : undefined);
    if (!invocation) {
      yield* Effect.logWarning("rejected MCP request with an unusable credential", {
        reason:
          authorization === undefined
            ? "missing_authorization_header"
            : authorization.split(" ", 1)[0]?.toLowerCase() !== "bearer"
              ? "unsupported_scheme"
              : token.length === 0
                ? "missing_bearer_token"
                : "unknown_or_expired_token",
      });
      return unauthorized({
        request,
        presentedToken: token.length > 0,
        offerOAuth: Option.isSome(clients) && !looksLikeProviderToken(token),
      });
    }
    const asked = withModeLimit(invocation, request);
    if (asked === undefined) return invalidModeLimit;
    const limited = McpInvocationContext.withRuntimeModeCeiling(asked, runtimeModeCeiling);
    const linkedEnvironments = yield* linksEnabled;
    if (limited.client?.linked === true && !linkedEnvironments) return linkedEnvironmentsOff;
    return yield* httpEffect.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...limited,
        linkedEnvironments,
      }),
      Effect.map(normalizeMcpHttpResponse),
    );
  }) satisfies McpAuthMiddleware;
}).pipe(Effect.withSpan("McpHttpServer.makeAuthMiddleware"));

const layerMcpAuthMiddleware = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

/** Claude Code spills oversized results to files, losing locators; bound both text and its preferred structuredContent. */
export const MAX_SNAPSHOT_TEXT_BYTES = 20_000;
export const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000;
export const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200;
export const MAX_SNAPSHOT_LOG_ENTRIES = 40;
export const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500;
export const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;

export const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");
export const cutText = (text: string, max: number) => {
  if (text.length <= max) return text;
  // Half an emoji serializes to a lone surrogate escape, which provider JSON parsers reject.
  const last = text.charCodeAt(max - 1);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)}…`;
};

export const cutEntryStrings = <A>(entry: A): A =>
  typeof entry === "object" && entry !== null
    ? (Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "string" ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ) as A)
    : entry;

export const hasLongString = (entry: unknown, max: number) =>
  typeof entry === "object" &&
  entry !== null &&
  Object.values(entry).some((value) => typeof value === "string" && value.length > max);

export type SnapshotMetadata = {
  readonly url: string;
  readonly title: string;
  readonly visibleText: string;
  readonly interactiveElements: ReadonlyArray<{
    readonly name: string;
    readonly [key: string]: unknown;
  }>;
  readonly consoleEntries: ReadonlyArray<unknown>;
  readonly networkEntries: ReadonlyArray<unknown>;
  readonly actionTimeline: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
};

class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
  "PreviewScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save preview screenshot to ${this.screenshotPath}.`;
  }
}

const MAX_SCREENSHOT_SITE_SLUG_LENGTH = 40;

const screenshotSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SCREENSHOT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

export const saveScreenshot = Effect.fn("McpHttpServer.saveScreenshot")(function* (
  pageUrl: string,
  data: Uint8Array,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const millis = yield* Clock.currentTimeMillis;
  const random = yield* SecureRandom.SecureRandom;
  const unique = (yield* random.uuidV4()).slice(0, 8);
  const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${unique}.png`;
  const screenshotPath = path.join(config.browserArtifactsDir, fileName);
  yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
    Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
  );
  return screenshotPath;
});

/** Decode with the advertised JSON codec, which permits null for optional fields that the raw schema rejects. */
export const decodeAsAdvertised = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Toolkit.Toolkit<Tools> =>
  Toolkit.make(
    ...Object.values(toolkit.tools).map((tool) =>
      tool.setParameters(Schema.toCodecJson(tool.parametersSchema)),
    ),
  ) as unknown as Toolkit.Toolkit<Tools>;

const isPreviewAutomationError = Schema.is(PreviewAutomationError);

export const previewSnapshotFailure = Effect.fn("previewSnapshotFailure")(function <E>(
  cause: Cause.Cause<E>,
) {
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
      : "PreviewSnapshotError";
  // Preview errors contain server-authored recovery guidance, never page output.
  const message = isPreviewAutomationError(firstFailure) ? firstFailure.message : undefined;
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
        ...(message === undefined ? {} : { message }),
      },
    },
    // Some clients show only the text content and others only structuredContent, so both carry it.
    content: [{ type: "text", text: `Preview snapshot failed: ${message ?? `${errorTag}.`}` }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
});

export interface ImageToolResult {
  readonly screenshot: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly [key: string]: unknown;
}

/** Expose only undescribed failures' tags; remote messages may contain renderer or device output. */
export const imageToolFailure =
  <E>(toolName: string, operation: string, failureText: string | ((error: E) => string)) =>
  (cause: Cause.Cause<E>) => {
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
    const message =
      typeof failureText === "string" || failures[0] === undefined
        ? undefined
        : failureText(failures[0].error);
    const result = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: {
        error: {
          _tag: errorTag,
          operation,
          failureCount: failures.length,
          ...(message === undefined ? {} : { message }),
        },
      },
      // Some clients show only the text content and others only structuredContent, so both carry it.
      content: [
        {
          type: "text",
          text: typeof failureText === "string" ? failureText : (message ?? `${toolName} failed.`),
        },
      ],
    });
    return Effect.logWarning(`${toolName} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

/**
 * `McpServer.toolkit` serializes every result as JSON text, which is the wrong
 * shape for a screenshot: the model needs image content.
 */
const registerDeviceScreenshot = Effect.fn("McpHttpServer.registerDeviceScreenshot")(function* () {
  const devices = yield* DeviceService.DeviceService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const built = yield* decodeAsAdvertised(DeviceScreenshotToolkit);
  yield* registerImageTool(
    DeviceScreenshotTool,
    (payload) =>
      built
        .handle("device_screenshot", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) =>
      effect.pipe(
        Effect.provideService(DeviceService.DeviceService, devices),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      ),
    "screenshot",
    (error) => {
      if (!isDeviceToolError(error)) {
        return isOrchestratorMcpFailure(error) ? error.message : "Device screenshot failed.";
      }
      return error._tag === "DeviceOperationError" && error.reason === "hub_rejected"
        ? `${error.message} Call device_list to check the device state, and device_open if it needs to be reopened.`
        : error.message;
    },
  );
});

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);
const isDeviceToolError = Schema.is(DeviceToolError);

const registerHtmlPreview = Effect.fn("McpHttpServer.registerHtmlPreview")(function* () {
  const htmlRender = yield* HtmlRender.HtmlRender;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const built = yield* decodeAsAdvertised(HtmlPreviewToolkit);
  yield* registerImageTool(
    HtmlPreviewTool,
    (payload) =>
      built
        .handle("html_preview", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) =>
      effect.pipe(
        Effect.provideService(HtmlRender.HtmlRender, htmlRender),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      ),
    "preview",

    (error) =>
      isOrchestratorMcpFailure(error) || AiError.isAiError(error)
        ? error.message
        : "HTML preview failed.",
  );
});

/**
 * Tools that hand work to another thread's agent: they create it, message it,
 * steer it, or move context into it. Their events name the receiving agent too.
 */
export const HANDOFF_TOOLS: ReadonlySet<string> = new Set([
  "delegate_task",
  "create_threads",
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_send_attachments",
  "schedule_task",
  "run_scheduled_task_now",
]);

/** Tool actions that hand work over with only a `{ sequence }` result; the input names the thread. */
const INPUT_TARGET_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  t3_queue: new Set(["edit", "promote_to_steer"]),
  t3_pending_request: new Set(["respond"]),
};

/** Tool actions that hand work over and name the receiving thread in their result. */
export const RESULT_TARGET_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  t3_thread_transfer: new Set(["fork", "merge_back"]),
};

export const hasAction = (
  actions: Readonly<Record<string, ReadonlySet<string>>>,
  tool: string,
  args: unknown,
) =>
  actions[tool]?.has(String((args as { readonly action?: unknown } | null | undefined)?.action)) ===
  true;

export const isInputTargetHandoff = (tool: string, args: unknown) =>
  hasAction(INPUT_TARGET_ACTIONS, tool, args);

const resultThreadKeys = ["childThreadId", "targetThreadId", "boundThreadId", "threadId"] as const;

/** Thread ids a handoff tool result names: the thread that received the work. */
const resultThreadIds = (content: unknown): ReadonlyArray<string> => {
  if (typeof content !== "object" || content === null) return [];
  const record = content as Readonly<Record<string, unknown>>;
  if (Array.isArray(record.threads)) return record.threads.flatMap(resultThreadIds);
  const key = resultThreadKeys.find((candidate) => typeof record[candidate] === "string");
  return key === undefined ? [] : [record[key] as string];
};

/**
 * Thread ids that received a handoff. The input's `threadId` is used only after
 * the call succeeded, so it is one the handler already resolved and authorized.
 */
export const handoffTargetIds = (
  tool: string,
  args: unknown,
  result: McpSchema.CallToolResult | undefined,
): ReadonlyArray<string> => {
  if (!isInputTargetHandoff(tool, args)) return resultThreadIds(result?.structuredContent);
  if (result === undefined || toolOutcome(result).outcome !== "ok") return [];
  const threadId = (args as { readonly threadId?: unknown } | null | undefined)?.threadId;
  return typeof threadId === "string" ? [threadId] : [];
};

/** Tool analytics must never include IDs, prompts or free text. */
const withAdvertisedSchemas = Effect.fn("McpHttpServer.withAdvertisedSchemas")(function* <
  Tools extends Record<string, Tool.Any>,
  A,
  E,
  R,
>(toolkit: Toolkit.Toolkit<Tools>, registration: Effect.Effect<A, E, R>) {
  const server = yield* McpServer.McpServer;
  const tools: Record<string, Tool.Any> = toolkit.tools;
  const advertisingServer = McpServer.McpServer.of({
    ...server,
    addTool: Effect.fn("McpServer.addTool")(function (options) {
      const tool = tools[options.tool.name];
      return server.addTool(
        tool === undefined
          ? options
          : {
              ...options,
              tool: new McpSchema.Tool({
                ...options.tool,
                inputSchema: advertisedJsonSchema(tool),
              }),
            },
      );
    }),
  });
  return yield* registration.pipe(Effect.provideService(McpServer.McpServer, advertisingServer));
});

/** Hands each call the services its registration was built with; the request's own still win. */
const provideRegistrationServices = <Services>() =>
  McpServer.middleware<{ provides: Services }>()(
    Effect.map(
      Effect.context<Services>(),
      (services) => (effect) =>
        Effect.updateContext(effect, (request: Context.Context<never>) =>
          Context.merge(services, request),
        ),
    ),
  );

/**
 * Tools declare their handler services as request-level dependencies. Those
 * built with the server are provided here; `McpInvocationContext` is left to
 * the transport, whose auth middleware resolves it per request.
 */
export const toolkitRegistration = <Tools extends Record<string, Tool.Any>, EX, RX>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) =>
  Layer.effectDiscard(
    withToolAnalytics(
      withAdvertisedSchemas(toolkit, McpServer.registerToolkit(decodeAsAdvertised(toolkit))),
    ),
  ).pipe(
    Layer.provide(
      provideRegistrationServices<
        Exclude<Tool.Requirements<Tools[keyof Tools]>, McpInvocationContext.McpInvocationContext>
      >().layer,
    ),
    Layer.provide(McpServer.McpServer.layer),
    Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)),
  );

const imageToolRegistration = <Tools extends Record<string, Tool.Any>, A, E, R, EX, RX>(
  register: Effect.Effect<A, E, R>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) =>
  Layer.effectDiscard(withToolAnalytics(register)).pipe(
    Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)),
  );

export const layerHtmlToolkit = Layer.mergeAll(
  toolkitRegistration(HtmlRenderToolkit, HtmlHandlers.layerRender),
  imageToolRegistration(registerHtmlPreview(), HtmlHandlers.layerPreview),
).pipe(Layer.provide(HtmlRender.layer));

const layerPreviewStandardToolkitRegistration = toolkitRegistration(
  PreviewStandardToolkit,
  PreviewHandlers.layerStandard,
);

const layerPreviewSnapshotRegistration = imageToolRegistration(
  registerPreviewSnapshot(),
  PreviewHandlers.layerSnapshot,
);

export const layerPreviewToolkit = Layer.mergeAll(
  layerPreviewStandardToolkitRegistration,
  layerPreviewSnapshotRegistration,
);

export const layerOrchestratorToolkit = toolkitRegistration(
  OrchestratorToolkit,
  OrchestratorHandlers.layer,
).pipe(Layer.provide(OrchestratorMcpService.layer), Layer.provide(ThreadMetadataMcpService.layer));

export const layerThreadToolkit = toolkitRegistration(ThreadToolkit, ThreadHandlers.layer);

const layerWorktreeToolkitRegistration = toolkitRegistration(
  WorktreeToolkit,
  WorktreeHandlers.layer,
).pipe(Layer.provide(WorktreeMcpService.layer));

const layerPreviewControlsRegistration = toolkitRegistration(
  PreviewControlsToolkit,
  PreviewControlsHandlers.layer,
);

const layerEnvironmentToolkit = toolkitRegistration(
  EnvironmentToolkit,
  EnvironmentHandlers.layer,
).pipe(Layer.provide(ThreadCommandExecutor.layer));

export const layerProjectRegistration = toolkitRegistration(ProjectToolkit, ProjectHandlers.layer);

export const layerAttachmentToolkit = toolkitRegistration(
  AttachmentToolkit,
  AttachmentHandlers.layer,
);

export const layerPullRequestsToolkit = toolkitRegistration(
  PullRequestsToolkit,
  PullRequestsHandlers.layer,
);

const layerDeviceStandardToolkitRegistration = toolkitRegistration(
  DeviceStandardToolkit,
  DeviceHandlers.layerStandard,
);

const layerDeviceScreenshotRegistration = imageToolRegistration(
  registerDeviceScreenshot(),
  DeviceHandlers.layerScreenshot,
);

export const layerDeviceToolkit = Layer.mergeAll(
  layerDeviceStandardToolkitRegistration,
  layerDeviceScreenshotRegistration,
);

/**
 * `McpServer` for in-process calls, which provide `McpInvocationContext`
 * around `callTool` as the auth middleware does for each /mcp request.
 */
export const layerInProcessMcpServer = McpServer.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(
  (effect) =>
    Effect.flatMap(
      Effect.serviceOption(McpInvocationContext.McpInvocationContext),
      Option.match({
        onNone: () => Effect.die("Provide McpInvocationContext around the in-process MCP call."),
        onSome: (scope) =>
          Effect.provideService(effect, McpInvocationContext.McpInvocationContext, scope),
      }),
    ),
  { global: true },
).pipe(Layer.provideMerge(McpServer.McpServer.layer));

export const layerMcpTransport = <RA, RE, RR>(registrations: Layer.Layer<RA, RE, RR>) =>
  McpServer.layerHttp({
    name: "T3 Code",
    version: packageJson.version,
    path: "/mcp",
    protocols: [McpProtocol.v2025_06_18],
    allowSessionTermination: true,
    registrations,
  }).pipe(Layer.provide(layerMcpAuthMiddleware));

/** Every tool the T3 MCP server advertises. AgentContextBudget.test.ts measures this set. */
export const layerTools = Layer.mergeAll(
  layerPreviewToolkit,
  layerOrchestratorToolkit,
  layerThreadToolkit,
  layerAttachmentToolkit,
  layerProjectRegistration,
  layerEnvironmentToolkit,
  layerPreviewControlsRegistration,
  layerWorktreeToolkitRegistration,
  layerPullRequestsToolkit,
  layerDeviceToolkit,
  layerHtmlToolkit,
);

export const layer = layerMcpTransport(layerTools);
