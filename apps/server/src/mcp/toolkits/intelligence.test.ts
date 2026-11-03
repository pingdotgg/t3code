import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type ProjectKnowledgeContext,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import * as ConversationSummaries from "../../project/conversationSummaries/ConversationSummaries.ts";
import * as CodeIntelligence from "../../project/knowledge/CodeIntelligence.ts";
import * as FileHistory from "../../project/knowledge/FileHistory.ts";
import * as ProjectKnowledge from "../../project/knowledge/ProjectKnowledge.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as ConversationSummaryHandlers from "./conversationSummaries/handlers.ts";
import { ConversationSummariesToolkit } from "./conversationSummaries/tools.ts";
import * as KnowledgeHandlers from "./knowledge/handlers.ts";
import { KnowledgeToolkit } from "./knowledge/tools.ts";
import * as ProjectCodeHandlers from "./projectCode/handlers.ts";
import { ProjectCodeToolkit } from "./projectCode/tools.ts";

const here = EnvironmentId.make("here");
const there = EnvironmentId.make("there");
const caller = (
  access: McpInvocationContext.McpClientCaller["access"] = "full-access",
): McpInvocationContext.McpInvocationScope => ({
  environmentId: here,
  requestNamespace: "client:intelligence-test",
  thread: undefined,
  client: { sessionId: "intelligence-test", label: "Agent", access },
  capabilities: new Set(["orchestration", "project-code"]),
  issuedAt: 0,
});
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "intelligence-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "intelligence-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

interface Forwarded {
  readonly tool: string;
  readonly environmentId: EnvironmentId;
  readonly input: unknown;
}
const registration = Layer.mergeAll(
  McpHttpServer.toolkitRegistration(KnowledgeToolkit, KnowledgeHandlers.layer),
  McpHttpServer.toolkitRegistration(
    ConversationSummariesToolkit,
    ConversationSummaryHandlers.layer,
  ),
  McpHttpServer.toolkitRegistration(ProjectCodeToolkit, ProjectCodeHandlers.layer),
).pipe(Layer.provideMerge(McpHttpServer.layerInProcessMcpServer));

const server = (
  forwarded: Array<Forwarded>,
  knowledge = Layer.mock(ProjectKnowledge.ProjectKnowledge)({}),
) =>
  registration.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        knowledge,
        Layer.mock(ConversationSummaries.ConversationSummaries)({}),
        Layer.mock(CodeIntelligence.CodeIntelligence)({}),
        Layer.mock(FileHistory.FileHistory)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
      ),
    ),
    Layer.provide(
      Layer.mock(PeerForwarding.PeerForwarding)({
        call: (_scope, tool, environmentId, input) => {
          forwarded.push({ tool: tool.name, environmentId, input });
          // No local domain service should execute for a remote request.
          return Effect.fail(
            new OrchestratorMcpFailure({ code: "invalid_request", message: "forwarded" }),
          );
        },
      }),
    ),
  );

const call = (name: string, input: Record<string, unknown>, scope = caller()) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((service) => service.callTool({ name, arguments: input })),
    Effect.map(({ content }) =>
      content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const preparation = {
  projectId: "project",
  selections: [{ kind: "fact", factId: "fact", revision: 1 }],
  maxBytes: 1000,
};
const mutation = {
  action: "feedback",
  projectId: "project",
  commandId: "feedback",
  factId: "fact",
  expectedRevision: 1,
  helpful: true,
};

it.effect.each([
  ["t3_knowledge_search", { projectId: "project", requestId: "recall", query: "cache" }],
  ["t3_knowledge_list", { projectId: "project" }],
  ["t3_knowledge_read_fact", { projectId: "project", factId: "fact" }],
  ["t3_knowledge_status", { projectId: "project" }],
  ["t3_knowledge_read_source", { projectId: "project", threadId: "thread", messageId: "message" }],
  ["t3_knowledge_prepare_context", preparation],
  ["t3_knowledge_mutate", { mutation }],
  ["t3_conversation_summary_list", { projectId: "project", threadId: "thread" }],
  [
    "t3_conversation_summary_describe",
    { projectId: "project", threadId: "thread", summaryId: `summary:${"a".repeat(64)}` },
  ],
  [
    "t3_conversation_summary_expand",
    { projectId: "project", threadId: "thread", summaryId: `summary:${"a".repeat(64)}` },
  ],
  [
    "t3_project_code_query",
    { projectId: "project", threadId: "thread", query: { operation: "status" } },
  ],
  ["t3_project_file_history", { projectId: "project", path: "src/cache.ts" }],
] as const)("routes %s to its selected environment before reading local ids", ([tool, input]) =>
  Effect.gen(function* () {
    const forwarded: Array<Forwarded> = [];
    const args = { ...input, environmentId: there };
    const result = yield* call(tool, args).pipe(Effect.provide(server(forwarded)));
    expect(result).toContain("forwarded");
    expect(forwarded).toEqual([{ tool, environmentId: there, input: args }]);
  }),
);

it.effect.each(["read-only", "approval-required"] as const)(
  "does not forward a knowledge mutation from a %s caller",
  (access) =>
    Effect.gen(function* () {
      const forwarded: Array<Forwarded> = [];
      const result = yield* call(
        "t3_knowledge_mutate",
        { mutation, environmentId: there },
        caller(access),
      ).pipe(Effect.provide(server(forwarded)));
      expect(result).toContain("capability_denied");
      expect(forwarded).toEqual([]);
    }),
);

it.effect.each([undefined, here, there])(
  "does not borrow a peer's filesystem access for a code query to %s",
  (environmentId) =>
    Effect.gen(function* () {
      const forwarded: Array<Forwarded> = [];
      const result = yield* call(
        "t3_project_code_query",
        {
          projectId: "project",
          query: { operation: "status" },
          ...(environmentId === undefined ? {} : { environmentId }),
        },
        { ...caller(), capabilities: new Set(["orchestration"]) },
      ).pipe(Effect.provide(server(forwarded)));
      expect(result).toContain("capability_denied");
      expect(result).toContain("filesystem:read");
      expect(forwarded).toEqual([]);
    }),
);

it.effect("rechecks a linked caller's mutation ceiling at the destination", () =>
  Effect.gen(function* () {
    const forwarded: Array<Forwarded> = [];
    const scope = caller("full-access");
    const result = yield* call(
      "t3_knowledge_mutate",
      { mutation },
      {
        ...scope,
        client: {
          ...scope.client!,
          linked: true,
          narrowedTo: { runtimeMode: "approval-required", interactionMode: "default" },
        },
      },
    ).pipe(Effect.provide(server(forwarded)));
    expect(result).toContain("capability_denied");
    expect(forwarded).toEqual([]);
  }),
);

it.effect.each([undefined, here, there])(
  "prepares context in the authenticated destination when the target is %s",
  (environmentId) =>
    Effect.gen(function* () {
      const forwarded: Array<Forwarded> = [];
      const prepared: Array<ProjectKnowledgeContext> = [];
      const destination = environmentId ?? here;
      const knowledge = Layer.mock(ProjectKnowledge.ProjectKnowledge)({
        prepareContext: (input) => {
          prepared.push(input);
          return Effect.succeed({ context: input, text: "context", byteLength: 7 });
        },
      });
      const result = yield* call(
        "t3_knowledge_prepare_context",
        {
          ...preparation,
          ...(environmentId === undefined ? {} : { environmentId }),
        },
        { ...caller(), environmentId: destination },
      ).pipe(Effect.provide(server(forwarded, knowledge)));
      expect(JSON.parse(result)).toEqual({
        context: { ...preparation, environmentId: destination },
        text: "context",
        byteLength: 7,
      });
      expect(prepared).toEqual([{ ...preparation, environmentId: destination }]);
      expect(forwarded).toEqual([]);
    }),
);
