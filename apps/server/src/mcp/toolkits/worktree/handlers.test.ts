import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";
import * as WorktreeToolkitHandlers from "./handlers.ts";
import { WorktreeToolkit } from "./tools.ts";

it.effect.each([
  { persisted: "kilo-cloud", configured: "kilo", cwd: null, explicit: true, allowed: false },
  { persisted: "kilo-cloud", configured: "missing", cwd: null, explicit: true, allowed: false },
  { persisted: null, configured: "kilo-cloud", cwd: null, explicit: true, allowed: false },
  {
    persisted: "kilo",
    configured: "kilo-cloud",
    cwd: "/local/worktree",
    explicit: true,
    allowed: true,
  },
  { persisted: null, configured: "kilo", cwd: null, explicit: true, allowed: true },
  { persisted: null, configured: "kilo", cwd: null, explicit: false, allowed: true },
  { persisted: null, configured: "missing", cwd: null, explicit: true, allowed: false },
])("keeps refs on the target workspace: %j", (test) =>
  Effect.gen(function* () {
    const targetId = ThreadId.make("target-thread");
    const instanceId = ProviderInstanceId.make("target-account");
    const gitCalls: string[] = [];
    const thread = {
      id: targetId,
      projectId: "target-project",
      providerInstanceId: instanceId,
      activeProviderThreadId: test.persisted ? "native-binding" : null,
      worktreePath: test.cwd,
      deletedAt: null,
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(thread as never),
        getProjectThreadRecords: () =>
          Effect.succeed({
            thread,
            providerThreads: test.persisted
              ? [{ id: "native-binding", driver: test.persisted }]
              : [],
          } as never),
      }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        getMetadata: (id) => {
          expect(id).toBe(instanceId);
          return test.configured === "missing"
            ? Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId: id }),
              )
            : Effect.succeed({ driver: ProviderDriverKind.make(test.configured) } as never);
        },
      }),
      Layer.mock(Project.ProjectService)({
        getById: () => Effect.succeed(Option.some({ workspaceRoot: "/local/project" } as never)),
      }),
      Layer.mock(GitWorkflow.GitWorkflowService)({
        listRefs: ({ cwd }) => {
          gitCalls.push(cwd);
          return Effect.succeed({
            refs: [],
            nextCursor: null,
            isRepo: true,
            hasPrimaryRemote: false,
            totalCount: 0,
          });
        },
      }),
      Layer.mock(WorktreeMcpService.WorktreeMcpService)({}),
    );
    const result = yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server
        .callTool({
          name: "t3_worktree_list",
          arguments: test.explicit ? { threadId: targetId } : {},
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment"),
            requestNamespace: "local-caller",
            thread: test.explicit
              ? undefined
              : {
                  threadId: targetId,
                  providerInstanceId: instanceId,
                  providerSessionId: "local-session",
                },
            client: test.explicit
              ? { sessionId: "client", label: "fixture", access: "full-access" }
              : undefined,
            capabilities: new Set<McpInvocationContext.McpCapability>([
              "orchestration",
              "worktree",
            ]),
            issuedAt: 0,
          }),
          Effect.provideService(McpSchema.McpServerClient, {
            clientId: 1,
            clientCapabilities: {},
            initializePayload: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "fixture", version: "1" },
            },
            getClient: Effect.die("unused"),
            clientInfo: { name: "fixture", version: "1" },
            protocolVersion: "2024-11-05",
          }),
        );
    }).pipe(
      Effect.provide(
        McpHttpServer.toolkitRegistration(WorktreeToolkit, WorktreeToolkitHandlers.layer).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(dependencies),
        ),
      ),
    );
    expect(gitCalls).toEqual(test.allowed ? [test.cwd ?? "/local/project"] : []);
    if (test.allowed) {
      expect(result.isError).toBe(false);
    } else {
      expect(result.isError).toBe(true);
      const text = result.content[0];
      const failure =
        text?.type === "text"
          ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text.text)
          : undefined;
      expect(failure).toMatchObject({
        code:
          test.persisted === null && test.configured === "missing"
            ? "orchestration_error"
            : "capability_denied",
      });
    }
  }),
);
