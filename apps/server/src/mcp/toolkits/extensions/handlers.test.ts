import { expect, it } from "@effect/vitest";
import { EnvironmentId, ExtensionError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as ExtensionService from "../../../extensions/ExtensionService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import { ExtensionsToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestratorMcpFailure));

it.effect("returns extension reasons and bounded diagnostics through the MCP tools", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const caller = yield* McpInvocationContext.McpInvocationContext;
    const readOnly = yield* server.callTool({ name: "extensions_list", arguments: {} }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...caller,
        client: { sessionId: "reader", label: "Read-only fixture", access: "read-only" },
      }),
    );
    expect(readOnly.isError).toBe(true);
    expect(JSON.stringify(readOnly.content)).not.toContain("fixture-secret");
    const listing = yield* server.callTool({ name: "extensions_list", arguments: {} });
    expect(listing.isError).not.toBe(true);
    expect(JSON.stringify(listing.content)).toContain("fixture-secret");
    for (const [name, args] of [
      ["extensions_invoke", { id: "test.example", kind: "command", name: "fail", input: {} }],
      ["extensions_install", { source: "missing-package", sourceType: "npm" }],
      ["extensions_manage", { id: "test.example", action: "reload" }],
      ["extensions_settings", { id: "test.example", settings: {} }],
    ] as const) {
      const result = yield* server.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      const failure = yield* decode(
        result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      );
      expect(failure.message).toContain("runtime-failed");
      expect(failure.message).toContain("Missing fixture file.");
      expect(failure.message.length).toBeLessThanOrEqual(8192);
    }
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment:extensions"),
      requestNamespace: "client:extensions",
      thread: undefined,
      client: { sessionId: "extensions", label: "Extension test", access: "full-access" },
      capabilities: new Set(["orchestration"] as const),
      issuedAt: 0,
    }),
    Effect.provideService(
      McpSchema.McpServerClient,
      McpSchema.McpServerClient.of({
        clientId: 1,
        protocolVersion: "2025-06-18",
        clientCapabilities: {},
        clientInfo: { name: "extensions", version: "1" },
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "extensions", version: "1" },
        },
        getClient: Effect.die("unused"),
      }),
    ),
    Effect.provide(
      McpHttpServer.toolkitRegistration(ExtensionsToolkit, Handlers.layer).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provideMerge(liveThreadsLayer),
        Layer.provide(
          Layer.mock(ExtensionService.ExtensionService)({
            list: Effect.succeed([
              {
                manifest: {
                  id: "test.credentials",
                  name: "Credentials",
                  version: "1.0.0",
                  apiVersion: 1,
                  main: "extension.mjs",
                  description: "Fixture",
                },
                source: "/extensions/credentials",
                sourceType: "local",
                enabled: true,
                status: "running",
                settings: { apiKey: "fixture-secret" },
              },
            ]),
            invoke: () =>
              Effect.fail(
                new ExtensionError({
                  operation: "invoke",
                  id: "test.example",
                  reason: "runtime-failed",
                  detail: `Missing fixture file. ${"x".repeat(9000)}`,
                }),
              ),
            install: () =>
              Effect.fail(
                new ExtensionError({
                  operation: "install",
                  id: "test.example",
                  reason: "runtime-failed",
                  detail: "Missing fixture file.",
                }),
              ),
            manage: () =>
              Effect.fail(
                new ExtensionError({
                  operation: "reload",
                  id: "test.example",
                  reason: "runtime-failed",
                  detail: "Missing fixture file.",
                }),
              ),
            setSettings: () =>
              Effect.fail(
                new ExtensionError({
                  operation: "settings",
                  id: "test.example",
                  reason: "runtime-failed",
                  detail: "Missing fixture file.",
                }),
              ),
          }),
        ),
      ),
    ),
  ),
);
