import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ExternalHistoryError,
  type ExternalHistoryRequest,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ExternalHistory from "../../../project/externalHistory/ExternalHistory.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Handlers from "./handlers.ts";
import { ExternalHistoryToolkit } from "./tools.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "external-history-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "external-history-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("history-environment"),
  requestNamespace: "client:history",
  thread: undefined,
  client: { sessionId: "history", label: "External client", access: "read-only" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

it.effect(
  "mounts the history tool for read-only clients, enforces scope and returns safe errors",
  () =>
    Effect.gen(function* () {
      const received: Array<ExternalHistoryRequest> = [];
      const service = Layer.mock(ExternalHistory.ExternalHistory)({
        query: (request) =>
          Effect.suspend(() => {
            received.push(request);
            return request.operation === "sources"
              ? Effect.succeed({
                  operation: "sources",
                  enabled: true,
                  sources: [{ id: "source", label: "Codex", kind: "codex" }],
                })
              : Effect.fail(
                  new ExternalHistoryError({
                    reason: "unavailable",
                    cause: new Error("private-source-path"),
                  }),
                );
          }),
      });
      const serverLayer = McpHttpServer.toolkitRegistration(
        ExternalHistoryToolkit,
        Handlers.layer,
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                deletedAt: null,
                runtimeMode: "full-access",
                interactionMode: "default",
              } as never),
          }),
        ),
        Layer.provide(service),
      );
      const call = (
        invocation: McpInvocationContext.McpInvocationScope,
        request: ExternalHistoryRequest,
      ) =>
        McpServer.McpServer.pipe(
          Effect.flatMap((server) =>
            server.callTool({ name: "t3_external_history", arguments: { request } }),
          ),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provide(serverLayer),
        );
      const result = yield* call(scope, { operation: "sources" });
      expect(result.isError).not.toBe(true);
      const denied = yield* call({ ...scope, capabilities: new Set() }, { operation: "sources" });
      expect(denied.isError).toBe(true);
      const subagent = yield* call(
        {
          ...scope,
          client: undefined,
          thread: {
            threadId: ThreadId.make("thread:history-child"),
            providerSessionId: "history-child",
            providerInstanceId: ProviderInstanceId.make("codex"),
            subagent: true,
          },
          issuedAt: 0,
        },
        { operation: "sources" },
      ).pipe(Effect.flip);
      expect(subagent.message).toContain("t3_external_history' not found");
      expect(received).toEqual([{ operation: "sources" }]);
      expect(received).toEqual([{ operation: "sources" }]);
      const failure = yield* call(scope, {
        operation: "search",
        sourceId: "source",
        query: "needle",
      });
      expect(failure.isError).toBe(true);
      const content = failure.content
        .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
        .join("\n");
      expect(content).toContain("orchestration_error");
      expect(content).not.toContain("private-source-path");
    }),
);
