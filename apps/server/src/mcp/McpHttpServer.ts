import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { PreviewToolkitHandlersLive } from "./toolkits/preview/handlers.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";

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

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    return Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization;
      const token =
        authorization?.startsWith("Bearer ") === true
          ? authorization.slice("Bearer ".length).trim()
          : "";
      const invocation = yield* registry.resolve(token);
      if (!invocation) return unauthorized;
      return yield* httpEffect.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.map(normalizeMcpHttpResponse),
      );
    });
  }),
).layer;

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const PreviewToolkitRegistrationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const built = yield* PreviewToolkit;
    const handleTool = built.handle as unknown as (
      name: keyof typeof built.tools,
      payload: unknown,
    ) => Effect.Effect<
      Stream.Stream<{ readonly encodedResult: unknown }, Error>,
      Error,
      McpInvocationContext.McpInvocationContext
    >;
    for (const tool of Object.values(built.tools)) {
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
          handleTool(tool.name as keyof typeof built.tools, payload).pipe(
            Stream.unwrap,
            Stream.run(Sink.last()),
            Effect.flatMap(Effect.fromOption),
            Effect.matchCause({
              onFailure: (cause) =>
                new McpSchema.CallToolResult({
                  isError: true,
                  content: [{ type: "text", text: Cause.pretty(cause) }],
                }),
              onSuccess: (result) => {
                if (tool.name === "preview_snapshot") {
                  const snapshot = result.encodedResult as {
                    readonly screenshot: {
                      readonly mimeType: "image/png";
                      readonly data: string;
                      readonly width: number;
                      readonly height: number;
                    };
                    readonly [key: string]: unknown;
                  };
                  const { screenshot, ...page } = snapshot;
                  const metadata = {
                    ...page,
                    screenshot: {
                      mimeType: screenshot.mimeType,
                      width: screenshot.width,
                      height: screenshot.height,
                    },
                  };
                  return new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent: metadata,
                    content: [
                      { type: "text", text: JSON.stringify(metadata) },
                      {
                        type: "image",
                        data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                        mimeType: screenshot.mimeType,
                      },
                    ],
                  });
                }
                const encodedResultText = JSON.stringify(result.encodedResult) ?? "null";
                return new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent:
                    result.encodedResult !== null && typeof result.encodedResult === "object"
                      ? result.encodedResult
                      : undefined,
                  content: [{ type: "text", text: encodedResultText }],
                });
              },
            }),
          ) as unknown as Effect.Effect<McpSchema.CallToolResult, never, McpSchema.McpServerClient>,
      });
    }
  }),
).pipe(Layer.provide(PreviewToolkitHandlersLive));

export const layer = Layer.mergeAll(PreviewToolkitRegistrationLive).pipe(
  Layer.provideMerge(McpTransportLive),
  Layer.provide(PreviewAutomationBroker.layer),
);
