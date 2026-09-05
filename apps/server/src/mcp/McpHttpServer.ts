import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { PreviewAutomationSnapshot } from "@t3tools/contracts";

import packageJson from "../../package.json" with { type: "json" };
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";

/**
 * Ceiling for the JSON metadata a `preview_snapshot` result hands the agent.
 * Chrome's full accessibility tree has no natural bound and alone ran to
 * hundreds of kilobytes on content-heavy pages, enough to crowd out the rest
 * of a thread's context, so it is the first thing to go. The ceiling sits
 * above what the producer's own caps (20k characters of visible text, 200
 * interactive elements) add up to on an ordinary page, so a snapshot without
 * the tree is normally sent whole. The screenshot travels beside the metadata
 * as an image and is never reduced.
 */
export const PREVIEW_SNAPSHOT_METADATA_MAX_BYTES = 100_000;
/** Longest title or URL kept once a snapshot has to be reduced at all. */
const PREVIEW_SNAPSHOT_IDENTIFIER_MAX_CHARS = 2_048;

type PreviewSnapshotMetadata = Omit<PreviewAutomationSnapshot, "screenshot"> & {
  readonly screenshot: Omit<PreviewAutomationSnapshot["screenshot"], "data">;
};

type OmittableField =
  | "accessibilityTree"
  | "networkEntries"
  | "consoleEntries"
  | "actionTimeline"
  | "interactiveElements";

/** Cuts a string to at most `length` UTF-16 units without splitting a surrogate pair. */
const cutText = (text: string, length: number): string => {
  const cut = text.slice(0, Math.max(0, length));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

const serializedBytes = (value: unknown) => {
  const serialized = JSON.stringify(value);
  return { serialized, bytes: Buffer.byteLength(serialized, "utf8") };
};

/**
 * Reduces snapshot metadata until it fits the limit, least useful field
 * first, and records what went. The order is what an agent can best do
 * without: the accessibility tree (redundant with the elements and the
 * screenshot), then the diagnostics logs, then the visible text is cut short,
 * and only then the interactive elements, which carry the locators the other
 * tools need. Every step keeps the result inside the tool's output schema.
 */
export function boundPreviewSnapshotMetadata(snapshot: PreviewAutomationSnapshot): {
  readonly metadata: PreviewSnapshotMetadata;
  readonly serialized: string;
} {
  const {
    screenshot: { data: _data, ...screenshot },
    ...page
  } = snapshot;
  let metadata: PreviewSnapshotMetadata = { ...page, screenshot };
  let { serialized, bytes } = serializedBytes(metadata);
  if (bytes <= PREVIEW_SNAPSHOT_METADATA_MAX_BYTES) {
    return { metadata, serialized };
  }

  const originalBytes = bytes;
  const omitted: string[] = [];
  const trimmed: string[] = [];
  const measure = (): number => {
    metadata = { ...metadata, truncation: { originalBytes, omitted, trimmed } };
    const measured = serializedBytes(metadata);
    serialized = measured.serialized;
    return measured.bytes;
  };
  const omit = (field: OmittableField): number => {
    metadata = { ...metadata, [field]: field === "accessibilityTree" ? null : [] };
    omitted.push(field);
    return measure();
  };

  // The title and URL are identifiers, not content. Past this length (a data:
  // URL, a runaway title) they carry nothing the agent needs, and either could
  // be the whole overrun by itself, so they are capped before any content goes.
  for (const field of ["title", "url"] as const) {
    if (metadata[field].length > PREVIEW_SNAPSHOT_IDENTIFIER_MAX_CHARS) {
      metadata = {
        ...metadata,
        [field]: cutText(metadata[field], PREVIEW_SNAPSHOT_IDENTIFIER_MAX_CHARS),
      };
      trimmed.push(field);
      bytes = measure();
    }
  }
  if (bytes <= PREVIEW_SNAPSHOT_METADATA_MAX_BYTES) {
    return { metadata, serialized };
  }

  if (metadata.accessibilityTree !== null && metadata.accessibilityTree !== undefined) {
    bytes = omit("accessibilityTree");
  }
  for (const field of ["networkEntries", "consoleEntries", "actionTimeline"] as const) {
    if (bytes <= PREVIEW_SNAPSHOT_METADATA_MAX_BYTES) break;
    if (metadata[field].length > 0) bytes = omit(field);
  }
  if (bytes > PREVIEW_SNAPSHOT_METADATA_MAX_BYTES && metadata.visibleText.length > 0) {
    trimmed.push("visibleText");
    while (bytes > PREVIEW_SNAPSHOT_METADATA_MAX_BYTES && metadata.visibleText.length > 0) {
      // Each pass keeps at most the share of the text the budget allows, so a
      // few passes converge even when escaping and multi-byte characters make
      // the serialized form larger than the character count.
      const share = Math.min(0.9, PREVIEW_SNAPSHOT_METADATA_MAX_BYTES / bytes);
      metadata = {
        ...metadata,
        visibleText: cutText(metadata.visibleText, Math.floor(metadata.visibleText.length * share)),
      };
      bytes = measure();
    }
  }
  if (bytes > PREVIEW_SNAPSHOT_METADATA_MAX_BYTES && metadata.interactiveElements.length > 0) {
    omit("interactiveElements");
  }
  return { metadata, serialized };
}

const formatKilobytes = (bytes: number) => `${Math.round(bytes / 1000)} KB`;

/** The plain-language half of a reduced result, beside the JSON the agent parses. */
const truncationNote = (metadata: PreviewSnapshotMetadata): string | undefined => {
  const truncation = metadata.truncation;
  if (truncation === undefined) return undefined;
  return [
    `Snapshot metadata was ${formatKilobytes(truncation.originalBytes)}, above the ${formatKilobytes(PREVIEW_SNAPSHOT_METADATA_MAX_BYTES)} limit sent to agents.`,
    ...(truncation.omitted.length > 0 ? [`Omitted: ${truncation.omitted.join(", ")}.`] : []),
    ...(truncation.trimmed.length > 0 ? [`Cut short: ${truncation.trimmed.join(", ")}.`] : []),
    "Use preview_evaluate for targeted reads of what was left out.",
  ].join(" ");
};

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
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

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map((registry): McpAuthMiddleware =>
    Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization;
      const token =
        authorization?.startsWith("Bearer ") === true
          ? authorization.slice("Bearer ".length).trim()
          : "";
      const invocation = yield* registry.resolve(token);
      if (!invocation) {
        // Without this the only symptom of a dead credential is the agent
        // quietly losing the whole `t3-code` toolkit for the rest of its
        // session, with nothing on the server to explain why.
        yield* Effect.logWarning("rejected MCP request with an unusable credential", {
          reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
        });
        return unauthorized;
      }
      return yield* httpEffect.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
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
      : "PreviewSnapshotError";
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

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
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
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: ({ encodedResult }) => {
              const snapshot = encodedResult as PreviewAutomationSnapshot;
              const { metadata, serialized } = boundPreviewSnapshotMetadata(snapshot);
              const note = truncationNote(metadata);
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: metadata,
                  content: [
                    { type: "text", text: serialized },
                    ...(note === undefined ? [] : [{ type: "text" as const, text: note }]),
                    {
                      type: "image",
                      data: new Uint8Array(Buffer.from(snapshot.screenshot.data, "base64")),
                      mimeType: snapshot.screenshot.mimeType,
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

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = PreviewToolkitRegistrationLive.pipe(Layer.provideMerge(McpTransportLive));
