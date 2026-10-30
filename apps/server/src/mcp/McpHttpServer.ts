import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
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

const mcpResourceMetadataUrl = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toURL(request).pipe(
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
  const linksEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );
  return Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    const token =
      authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length).trim()
        : "";
    const invocation =
      (yield* registry.resolve(token)) ??
      (Option.isSome(clients) && token.length > 0
        ? yield* clients.value.authenticate(request)
        : undefined);
    if (!invocation) {
      yield* Effect.logWarning("rejected MCP request with an unusable credential", {
        reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
      });
      return unauthorized({
        request,
        presentedToken: token.length > 0,
        offerOAuth: Option.isSome(clients) && !looksLikeProviderToken(token),
      });
    }
    const limited = withModeLimit(invocation, request);
    if (limited === undefined) return invalidModeLimit;
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
const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000;
const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200;
const MAX_SNAPSHOT_LOG_ENTRIES = 40;
const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500;
const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");
const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const cutEntryStrings = <A>(entry: A): A =>
  typeof entry === "object" && entry !== null
    ? (Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "string" ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ) as A)
    : entry;

const hasLongString = (entry: unknown, max: number) =>
  typeof entry === "object" &&
  entry !== null &&
  Object.values(entry).some((value) => typeof value === "string" && value.length > max);

type SnapshotMetadata = {
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

const boundSnapshotMetadata = (metadata: SnapshotMetadata) => {
  const omitted: Array<string> = [];
  const { accessibilityTree, ...withoutTree } = metadata;
  const ariaTree = typeof accessibilityTree === "string" ? accessibilityTree : undefined;
  if (accessibilityTree !== undefined && ariaTree === undefined) {
    omitted.push("accessibilityTree (use interactiveElements locators or preview_evaluate)");
  }
  const tail = <A>(entries: ReadonlyArray<A>, label: string) => {
    if (entries.length > MAX_SNAPSHOT_LOG_ENTRIES) {
      omitted.push(`${entries.length - MAX_SNAPSHOT_LOG_ENTRIES} older ${label}`);
    }
    const kept = entries.slice(-MAX_SNAPSHOT_LOG_ENTRIES);
    if (kept.some((entry) => hasLongString(entry, MAX_SNAPSHOT_LOG_TEXT_CHARS))) {
      omitted.push(`${label} text after ${MAX_SNAPSHOT_LOG_TEXT_CHARS} characters`);
    }
    return kept.map(cutEntryStrings);
  };
  if (
    metadata.url.length > MAX_SNAPSHOT_IDENTIFIER_CHARS ||
    metadata.title.length > MAX_SNAPSHOT_IDENTIFIER_CHARS
  ) {
    omitted.push(`url or title after ${MAX_SNAPSHOT_IDENTIFIER_CHARS} characters`);
  }
  if (
    metadata.interactiveElements.some(
      (element) => element.name.length > MAX_SNAPSHOT_ELEMENT_NAME_CHARS,
    )
  ) {
    omitted.push(`element names longer than ${MAX_SNAPSHOT_ELEMENT_NAME_CHARS} characters`);
  }
  const bounded = {
    ...withoutTree,
    url: cutText(metadata.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    title: cutText(metadata.title, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    interactiveElements: metadata.interactiveElements.map((element) => ({
      ...element,
      name: cutText(element.name, MAX_SNAPSHOT_ELEMENT_NAME_CHARS),
    })),
    consoleEntries: tail(metadata.consoleEntries, "console entries"),
    networkEntries: tail(metadata.networkEntries, "network entries"),
    actionTimeline: tail(metadata.actionTimeline, "action timeline entries"),
  };

  // Per-field character caps can still exceed the total byte ceiling.
  const shedOrder = [
    "actionTimeline",
    "networkEntries",
    "consoleEntries",
    "interactiveElements",
  ] as const;
  const lists: Record<(typeof shedOrder)[number], ReadonlyArray<unknown>> = {
    interactiveElements: bounded.interactiveElements,
    consoleEntries: bounded.consoleEntries,
    networkEntries: bounded.networkEntries,
    actionTimeline: bounded.actionTimeline,
  };
  const dropped: Record<(typeof shedOrder)[number], number> = {
    interactiveElements: 0,
    consoleEntries: 0,
    networkEntries: 0,
    actionTimeline: 0,
  };
  let visibleTextChars = Math.min(metadata.visibleText.length, MAX_SNAPSHOT_VISIBLE_TEXT_CHARS);
  let ariaTreeChars = Math.min(ariaTree?.length ?? 0, 20_000);
  const value = () => ({
    ...bounded,
    ...(ariaTree === undefined ? {} : { accessibilityTree: cutText(ariaTree, ariaTreeChars) }),
    visibleText: cutText(metadata.visibleText, visibleTextChars),
    ...lists,
  });
  let text = encodeJsonText(value());
  while (utf8Length(text) > MAX_SNAPSHOT_TEXT_BYTES) {
    // Elements carry the locators, so they go last; logs shed newest-last.
    const key =
      shedOrder.find(
        (candidate) => candidate !== "interactiveElements" && lists[candidate].length > 0,
      ) ??
      (visibleTextChars > 0
        ? "visibleText"
        : lists.interactiveElements.length > 0
          ? "interactiveElements"
          : ariaTreeChars > 0
            ? "accessibilityTree"
            : undefined);
    if (key === undefined) break;
    if (key === "visibleText") {
      visibleTextChars = Math.floor(visibleTextChars / 2);
    } else if (key === "accessibilityTree") {
      ariaTreeChars = Math.floor(ariaTreeChars / 2);
    } else {
      const keep = Math.floor(lists[key].length / 2);
      dropped[key] += lists[key].length - keep;
      lists[key] =
        keep === 0
          ? []
          : key === "interactiveElements"
            ? lists[key].slice(0, keep)
            : lists[key].slice(-keep);
    }
    text = encodeJsonText(value());
  }
  if (visibleTextChars < metadata.visibleText.length) {
    omitted.push(
      `visibleText after ${visibleTextChars} characters (use preview_evaluate for more)`,
    );
  }
  if (ariaTree !== undefined && ariaTreeChars < ariaTree.length) {
    omitted.push(`accessibilityTree after ${ariaTreeChars} characters`);
  }
  for (const key of shedOrder) {
    if (dropped[key] > 0) {
      omitted.push(`${dropped[key]} of ${bounded[key].length} ${key}`);
    }
  }
  return { value: value(), text, omitted };
};

export class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
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

const saveScreenshot = Effect.fn("McpHttpServer.saveScreenshot")(function* (
  pageUrl: string,
  data: Uint8Array,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const millis = yield* Clock.currentTimeMillis;
  const crypto = yield* Crypto.Crypto;
  const unique = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8);
  const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${unique}.png`;
  const screenshotPath = path.join(config.browserArtifactsDir, fileName);
  yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
    Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
  );
  return screenshotPath;
});

const MAX_NAMED_ARGUMENTS = 5;
const MAX_ARGUMENT_NAME_CHARS = 64;

/**
 * Rejects top-level arguments the advertised schema does not list, naming them. Nested objects stay lenient:
 * the advertised schema merges tagged unions, so strict decoding would reject keys agents were shown.
 */
const advertisedArgumentsOnly = (tool: Tool.Any) => {
  const { properties } = advertisedJsonSchema(tool);
  const accepted = new Set(Predicate.isObject(properties) ? Object.keys(properties) : []);
  const acceptedText = [...accepted].join(", ") || "none";
  return Schema.Record(Schema.String, Schema.Unknown).check(
    Schema.makeFilter((input) => {
      const unknown = Object.keys(input).filter((key) => !accepted.has(key));
      if (unknown.length === 0) return undefined;
      const named = unknown
        .slice(0, MAX_NAMED_ARGUMENTS)
        .map((key) => JSON.stringify(cutText(key, MAX_ARGUMENT_NAME_CHARS)));
      const more =
        unknown.length > named.length ? ` and ${unknown.length - named.length} more` : "";
      return `Unknown argument${unknown.length === 1 ? "" : "s"} ${named.join(", ")}${more}. Accepted arguments: ${acceptedText}.`;
    }),
  );
};

/** Decode with the advertised JSON codec, which permits null for optional fields that the raw schema rejects. */
const decodeAsAdvertised = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Toolkit.Toolkit<Tools> =>
  Toolkit.make(
    ...Object.values(toolkit.tools).map((tool) =>
      tool.setParameters(
        advertisedArgumentsOnly(tool).pipe(
          Schema.decodeTo(Schema.toCodecJson(tool.parametersSchema)),
        ),
      ),
    ),
  ) as unknown as Toolkit.Toolkit<Tools>;

const parameterValidationMessage = (error: unknown) =>
  AiError.isAiError(error) && error.reason._tag === "ToolParameterValidationError"
    ? error.reason.message
    : undefined;

const isPreviewAutomationError = Schema.is(PreviewAutomationError);

const previewSnapshotFailure = Effect.fn("previewSnapshotFailure")(function <E>(
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
  const message = isPreviewAutomationError(firstFailure)
    ? firstFailure.message
    : parameterValidationMessage(firstFailure);
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

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const saveServices = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >();
  const built = yield* decodeAsAdvertised(PreviewSnapshotToolkit);
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: advertisedJsonSchema(tool),
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
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.flatMap(({ encodedResult }) =>
            Effect.gen(function* () {
              const snapshot = encodedResult as SnapshotMetadata & {
                readonly url: string;
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
              };
              const { screenshot, ...page } = snapshot;
              const png = new Uint8Array(Buffer.from(screenshot.data, "base64"));
              const screenshotPath =
                payload?.save === true ? yield* saveScreenshot(snapshot.url, png) : undefined;
              // Providers replay images on later requests, and some reject them; include images only when requested.
              const includeImage = payload?.includeImage === true;
              if (screenshotPath !== undefined && !includeImage) {
                const saved = {
                  url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
                  screenshotPath,
                };
                return new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: saved,
                  content: [{ type: "text", text: encodeJsonText(saved) }],
                });
              }
              const metadata = {
                ...page,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
                ...(screenshotPath === undefined ? {} : { screenshotPath }),
              };
              const bounded = boundSnapshotMetadata(metadata);
              return new McpSchema.CallToolResult({
                isError: false,
                structuredContent:
                  bounded.omitted.length === 0
                    ? bounded.value
                    : { ...bounded.value, omitted: bounded.omitted },
                content: [
                  {
                    type: "text",
                    text: encodeJsonText({
                      url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
                    }),
                  },
                  { type: "text", text: bounded.text },
                  ...(bounded.omitted.length === 0
                    ? []
                    : [
                        {
                          type: "text" as const,
                          text: `Snapshot text was bounded. Omitted: ${bounded.omitted.join("; ")}.`,
                        },
                      ]),
                  ...(includeImage
                    ? [{ type: "image" as const, data: png, mimeType: screenshot.mimeType }]
                    : []),
                ],
              });
            }),
          ),
          Effect.provide(saveServices),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: Effect.succeed,
          }),
        );
      }),
  });
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

/** Expose only undescribed failures' tags; remote messages may contain renderer or device output. */
const imageToolFailure =
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
const registerImageTool = Effect.fn("McpHttpServer.registerImageTool")(function* <
  T extends Tool.Any,
  E,
  R,
>(
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
  failureText: string | ((error: E) => string),
) {
  const server = yield* McpServer.McpServer;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: advertisedJsonSchema(tool),
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
                    {
                      type: "image" as const,
                      data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                      mimeType: screenshot.mimeType,
                    },
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
    (error) =>
      isDeviceToolError(error) || isOrchestratorMcpFailure(error)
        ? error.message
        : (parameterValidationMessage(error) ?? "Device screenshot failed."),
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
const HANDOFF_TOOLS: ReadonlySet<string> = new Set([
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
const RESULT_TARGET_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  t3_thread_transfer: new Set(["fork", "merge_back"]),
};

const hasAction = (
  actions: Readonly<Record<string, ReadonlySet<string>>>,
  tool: string,
  args: unknown,
) =>
  actions[tool]?.has(String((args as { readonly action?: unknown } | null | undefined)?.action)) ===
  true;

const isInputTargetHandoff = (tool: string, args: unknown) =>
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
const handoffTargetIds = (
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
const withToolAnalytics =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* <A, E, R>(registration: Effect.Effect<A, E, R>) {
    const server = yield* McpServer.McpServer;
    const analytics = yield* Effect.serviceOption(AnalyticsService.AnalyticsService);
    if (Option.isNone(analytics)) return yield* registration;
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const threads = yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService);
    const shellOf = (threadId: string) =>
      Option.isNone(threads)
        ? Effect.succeed(null)
        : threads.value
            .getThreadShell(ThreadId.make(threadId))
            .pipe(Effect.orElseSucceed(() => null));
    // Delegation depth: parents walked from the caller, capped.
    const depthOf =
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(function* (thread: AgentThread) {
        let depth = 0;
        let parentId =
          thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null;
        while (parentId !== null && depth < MAX_REPORTED_DEPTH) {
          depth += 1;
          const parent = yield* shellOf(parentId);
          parentId =
            parent?.lineage.relationshipToParent === "subagent"
              ? parent.lineage.parentThreadId
              : null;
        }
        return depth;
      });
    // Whether the caller's active run was started by a scheduled task.
    const scheduledRunOf = (threadId: string, runId: RunId | null) =>
      Option.isNone(threads) || runId === null
        ? Effect.succeed(false)
        : threads.value
            .getThreadRecords(ThreadId.make(threadId), ["runs", "messages"], {
              runIds: [runId],
              messageRoles: ["user"],
            })
            .pipe(
              Effect.map((records) => {
                const run = records.runs.find((candidate) => candidate.id === runId);
                return records.messages.some(
                  (message) =>
                    message.id === run?.userMessageId && message.scheduledTaskId !== undefined,
                );
              }),
              Effect.orElseSucceed(() => false),
            );
    const record =
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(
        function* (
          tool: string,
          args: unknown,
          result: McpSchema.CallToolResult | undefined,
          durationMs: number,
        ) {
          const handoff =
            HANDOFF_TOOLS.has(tool) ||
            isInputTargetHandoff(tool, args) ||
            hasAction(RESULT_TARGET_ACTIONS, tool, args);
          const outcome = toolOutcome(result);
          // Agents call status, read, and preview tools in tight loops, so an
          // event per successful call floods analytics. Only failures count there.
          if (!handoff && outcome.outcome === "ok") return;
          // Client credentials (no calling thread) report an unknown caller.
          const invocation = Option.getOrUndefined(
            yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext),
          )?.thread;
          const providers = Option.isSome(registry) ? yield* registry.value.getProviders : [];
          // Only handoff tools pay for thread lookups; the rest report the
          // caller's provider from the credential.
          const caller =
            handoff && invocation !== undefined
              ? ((yield* shellOf(invocation.threadId)) ?? undefined)
              : undefined;
          const targetIds = handoff
            ? [...new Set(handoffTargetIds(tool, args, result))].filter(
                (threadId) => threadId !== invocation?.threadId,
              )
            : [];
          const targets = yield* Effect.forEach(targetIds, shellOf);
          for (const properties of agentToolProperties({
            tool,
            providers,
            caller,
            ...(invocation === undefined
              ? {}
              : { callerProviderInstanceId: invocation.providerInstanceId }),
            ...(caller === undefined || invocation === undefined
              ? {}
              : {
                  callerDepth: yield* depthOf(caller),
                  callerScheduledRun: yield* scheduledRunOf(
                    invocation.threadId,
                    caller.activeRunId,
                  ),
                }),
            targets: targets.filter((thread) => thread !== null),
            outcome,
            ...(handoff
              ? { settings: handoffSettings(tool, args, result?.structuredContent) }
              : {}),
            durationMs,
          })) {
            yield* analytics.value.record("mcp.tool.invoked", properties);
          }
        },
        (effect, _tool, _args, _result, _durationMs) => effect.pipe(Effect.ignoreCause),
      );
    const recordingServer = McpServer.McpServer.of({
      ...server,
      addTool: Effect.fn("McpServer.addTool")(function (options) {
        return server.addTool({
          ...options,
          handle:
            /* Request instrumentation already owns the span; keep this helper in that context. */
            Effect.fnUntraced(function* (payload) {
              const startedAt = yield* Clock.currentTimeMillis;
              return yield* options.handle(payload).pipe(
                Effect.onExit((exit) => {
                  const result = exit._tag === "Success" ? exit.value : undefined;
                  // A call that asks for input is retried with it, and that call is the one counted.
                  if (result instanceof McpSchema.InputRequired) return Effect.void;
                  // Handoff tools look up threads to record; the response must not wait on them.
                  return Clock.currentTimeMillis.pipe(
                    Effect.flatMap((endedAt) =>
                      record(options.tool.name, payload, result, endedAt - startedAt),
                    ),
                    Effect.forkDetach,
                    Effect.asVoid,
                  );
                }),
              );
            }),
        });
      }),
    });
    return yield* registration.pipe(Effect.provideService(McpServer.McpServer, recordingServer));
  });

/** `McpServer.registerToolkit` advertises the full codec schema; agents get the compact one. */
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

/**
 * `McpServer.toolkit` asks for every service its tools declare when it
 * registers them, but the auth middleware provides `McpInvocationContext` to
 * each request instead. Registration must not get one: the services it
 * captures would replace the request's.
 */
export const toolkitRegistration = <Tools extends Record<string, Tool.Any>, EX, RX>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) => {
  const registration = Layer.effectDiscard(
    withToolAnalytics(
      withAdvertisedSchemas(toolkit, McpServer.registerToolkit(decodeAsAdvertised(toolkit))),
    ),
  ).pipe(Layer.provide(McpServer.McpServer.layer));
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off - the auth middleware provides it per request.
  const registered = registration as Layer.Layer<
    never,
    never,
    Exclude<Layer.Services<typeof registration>, McpInvocationContext.McpInvocationContext>
  >;
  return registered.pipe(Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)));
};

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

export const layerMcpTransport = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
  allowSessionTermination: true,
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

export const layer = layerTools.pipe(Layer.provideMerge(layerMcpTransport));
