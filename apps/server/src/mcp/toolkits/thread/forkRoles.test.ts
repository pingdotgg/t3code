import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ForkRolesListResult,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ForkRoles from "../../../orchestration-v2/ForkRoles.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("fork-roles-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("fork-roles-environment"),
  requestNamespace: "fork-roles-session",
  thread: {
    threadId,
    providerSessionId: "fork-roles-session",
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
  clientInfo: { name: "fork-roles", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fork-roles", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const roles = (listing: ForkRolesListResult) =>
  Layer.succeed(ForkRoles.ForkRoles, {
    list: Effect.succeed(listing),
    readBrief: () => Effect.undefined,
  });

const withServer = (dispatched: Array<OrchestrationV2ServerCommand>) =>
  McpHttpServer.layerThreadToolkit.pipe(
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
        getProjectThreadRecords: ({ threadId: id }) =>
          Effect.succeed(
            McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(id)),
          ),
        dispatch: (command) => {
          dispatched.push(command);
          return Effect.succeed({ sequence: 1 } as never);
        },
      }),
    ),
  );

const organize = (args: Record<string, unknown>, listing: ForkRolesListResult) =>
  Effect.flatMap(McpServer.McpServer, (server) =>
    server.callTool({ name: "t3_thread_organize", arguments: args }),
  ).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(roles(listing)),
  );

const listing: ForkRolesListResult = {
  directory: "/roles",
  roles: [
    { id: "needs-you", name: "Needs you", path: "/roles/needs-you.md" },
    { id: "inbox", name: "inbox", path: "/roles/inbox.md" },
  ],
};

it.effect("set_role and clear_role dispatch thread.role.set on the calling thread", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const set = yield* organize({ action: "set_role", roleId: "needs-you" }, listing);
    expect(set.isError).toBe(false);
    const cleared = yield* organize({ action: "clear_role" }, listing);
    expect(cleared.isError).toBe(false);
    expect(dispatched).toMatchObject([
      { type: "thread.role.set", threadId, roleId: "needs-you" },
      { type: "thread.role.set", threadId, roleId: null },
    ]);
  }).pipe(Effect.provide(withServer(dispatched)));
});

it.effect("set_role refuses a missing role file and lists the available ids", () => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  return Effect.gen(function* () {
    const missing = yield* organize({ action: "set_role", roleId: "gone" }, listing);
    expect(declaredFailure(missing)).toMatchObject({
      code: "invalid_request",
      message: "No role file gone.md in /roles. Available roles: needs-you, inbox.",
    });
    const noId = yield* organize({ action: "set_role" }, listing);
    expect(declaredFailure(noId)).toMatchObject({
      message: "set_role requires roleId. Available roles: needs-you, inbox.",
    });
    const off = yield* organize(
      { action: "set_role", roleId: "needs-you" },
      { directory: null, roles: [] },
    );
    expect(declaredFailure(off)).toMatchObject({
      message: expect.stringContaining("No roles directory is set"),
    });
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(withServer(dispatched)));
});
