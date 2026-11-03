import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectFactId,
  ProjectKnowledgeError,
  ProviderInstanceId,
  ThreadId,
  type KnowledgeOrigin,
  type ProjectKnowledgeMutation,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectKnowledge from "../../../project/knowledge/ProjectKnowledge.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as KnowledgeHandlers from "./handlers.ts";
import { KnowledgeToolkit } from "./tools.ts";

const threadId = ThreadId.make("mcp-knowledge-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-knowledge-environment"),
  requestNamespace: "mcp-knowledge-session",
  thread: {
    threadId,
    providerSessionId: "mcp-knowledge-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-knowledge", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-knowledge", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const mutation: ProjectKnowledgeMutation = {
  action: "create",
  commandId: CommandId.make("mcp-knowledge-command"),
  projectId: ProjectId.make("mcp-knowledge-project"),
  factId: ProjectFactId.make("mcp-knowledge-fact"),
  content: "Use the existing schema as the MCP input.",
  entities: [],
  tags: [],
  kind: "note",
  sources: [],
};

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

it.effect("registers knowledge tools and preserves the mutation and caller origin", () =>
  Effect.gen(function* () {
    const received = yield* Ref.make<
      { readonly input: ProjectKnowledgeMutation; readonly actor: KnowledgeOrigin } | undefined
    >(undefined);
    const knowledge = Layer.mock(ProjectKnowledge.ProjectKnowledge)({
      mutateWithHints: (input, actor) =>
        Ref.set(received, { input, actor }).pipe(
          Effect.andThen(
            Effect.fail(
              new ProjectKnowledgeError({ reason: "missing_project", projectId: input.projectId }),
            ),
          ),
        ),
    });
    const serverLayer = McpHttpServer.toolkitRegistration(
      KnowledgeToolkit,
      KnowledgeHandlers.layer,
    ).pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed(id === threadId ? McpToolAccessTestkit.liveThreadShell(id) : null),
        }),
      ),
      Layer.provide(knowledge),
    );
    const call = (
      invocation: McpInvocationContext.McpInvocationScope,
      input: ProjectKnowledgeMutation = mutation,
    ) =>
      McpServer.McpServer.pipe(
        Effect.flatMap((server) =>
          server.callTool({ name: "t3_knowledge_mutate", arguments: { mutation: input } }),
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provide(serverLayer),
      );
    const result = yield* call(scope);
    const denied = yield* call(
      { ...scope, capabilities: new Set() },
      {
        ...mutation,
        content: "This input must not reach the service.",
      },
    );
    expect(declaredFailure(result)).toMatchObject({ code: "invalid_request" });
    expect(declaredFailure(denied)).toMatchObject({ code: "capability_denied" });
    expect(yield* Ref.get(received)).toEqual({
      input: mutation,
      actor: {
        kind: "agent-thread",
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    });
  }),
);
