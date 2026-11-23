import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as BotRepository from "../../../bots/BotRepository.ts";
import * as BotService from "../../../bots/BotService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const decodeThreadId = Schema.decodeUnknownSync(ThreadId);
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);

const localEnvId = EnvironmentId.make("env-local");
const remoteEnvId = EnvironmentId.make("env-remote");
const fullAccessThreadId = decodeThreadId("thread-full-access");
const supervisedThreadId = decodeThreadId("thread-supervised");

const fullAccessScope: McpInvocationContext.McpInvocationScope = {
  environmentId: localEnvId,
  requestNamespace: "session:full-access",
  thread: {
    threadId: fullAccessThreadId,
    providerSessionId: "session:full-access",
    providerInstanceId: decodeProviderInstanceId("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const supervisedScope: McpInvocationContext.McpInvocationScope = {
  environmentId: localEnvId,
  requestNamespace: "session:supervised",
  thread: {
    threadId: supervisedThreadId,
    providerSessionId: "session:supervised",
    providerInstanceId: decodeProviderInstanceId("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const readOnlyClientScope: McpInvocationContext.McpInvocationScope = {
  environmentId: localEnvId,
  requestNamespace: "client:read-only",
  thread: undefined,
  client: {
    sessionId: "client:read-only",
    label: "Read-only client",
    access: "read-only",
    linked: false,
  },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "bots-mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bots-mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const parseResult = <A>(result: McpSchema.CallToolResult): A => {
  const first = result.content[0];
  if (first?.type !== "text") {
    throw new Error("Expected text tool result");
  }
  return JSON.parse(first.text) as A;
};

function makeHarness() {
  let threadCounter = 0;
  const forwardedCalls: Array<{
    readonly tool: string;
    readonly environmentId: EnvironmentId;
    readonly params: unknown;
  }> = [];

  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>([
    [fullAccessThreadId, liveThreadShell(fullAccessThreadId, { runtimeMode: "full-access" })],
    [supervisedThreadId, liveThreadShell(supervisedThreadId, { runtimeMode: "auto-accept-edits" })],
  ]);

  const mockProjectService = Layer.mock(ProjectService.ProjectService)({
    create: () => Effect.succeed({} as never),
    delete: () => Effect.succeed({} as never),
  });

  const mockThreadLaunch = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
    launch: () =>
      Effect.sync(() => {
        threadCounter += 1;
        return {
          threadId: decodeThreadId(`bot-thread-${threadCounter}`),
          projection: {} as never,
          resumed: false,
        };
      }),
  });

  const mockThreadManagement = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
    sendToThread: () => Effect.succeed({} as never),
  });

  const mockProviderRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([
      {
        instanceId: decodeProviderInstanceId("claudeAgent"),
        enabled: true,
        status: "ready",
        models: [{ slug: "claude-sonnet-5-5" }],
      } as never,
    ]),
  });

  const mockProcessRunner = Layer.mock(ProcessRunner.ProcessRunner)({
    run: () =>
      Effect.succeed({
        stdout: "changed",
        stderr: "",
        code: 0 as never,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });

  const mockPeerForwarding = Layer.mock(PeerForwarding.PeerForwarding)({
    call: (_scope, tool, environmentId, params) =>
      Effect.sync(() => {
        forwardedCalls.push({ tool: tool.name, environmentId, params });
        return { bots: [] } as never;
      }),
  });

  const botServiceLayer = BotService.layer.pipe(
    Layer.provideMerge(BotRepository.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-bots-mcp-test-" }),
        SqlitePersistence.layerMemory,
        mockProjectService,
        mockThreadLaunch,
        mockThreadManagement,
        mockProviderRegistry,
        mockProcessRunner,
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

  const serverLayer = McpHttpServer.layerBotsToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(botServiceLayer),
    Layer.provideMerge(mockPeerForwarding),
  );

  const callTool = (
    name: string,
    args: Record<string, unknown>,
    scope: McpInvocationContext.McpInvocationScope = fullAccessScope,
  ) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server.callTool({ name, arguments: args });
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
    );

  return { serverLayer, callTool, forwardedCalls };
}

describe("Bots MCP toolkit", () => {
  it.effect("manages bots, files, routines, groups, and items end to end", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const createdRes = yield* harness.callTool("bot_create", {
        name: "PR Review",
        slug: "pr-review",
        avatar: "🔍",
        avatarColor: "indigo",
        modelSelection: {
          instanceId: "claudeAgent",
          model: "claude-sonnet-5-5",
        },
        runtimeMode: "auto-accept-edits",
        soulContent: "# PR Review\nReview open pull requests.\n",
        tidyUpTimeOfDay: "02:30",
        firstRun: false,
      });
      expect(createdRes.isError).not.toBe(true);
      const created = parseResult<{
        id: string;
        slug: string;
        providerInstanceId: string | null;
        tidyUpTimeOfDay: string;
      }>(createdRes);
      expect(created.slug).toBe("pr-review");
      expect(created.providerInstanceId).toBe("claudeAgent");
      expect(created.tidyUpTimeOfDay).toBe("02:30");

      const listRes = yield* harness.callTool("bot_list", {});
      const listed = parseResult<{ bots: Array<{ id: string }> }>(listRes);
      expect(listed.bots.map((b) => b.id)).toContain(created.id);

      const updatedRes = yield* harness.callTool("bot_update", {
        botId: created.id,
        tidyUpTimeOfDay: "03:00",
        paused: true,
      });
      expect(updatedRes.isError).not.toBe(true);
      const updated = parseResult<{ paused: boolean; tidyUpTimeOfDay: string }>(updatedRes);
      expect(updated.paused).toBe(true);
      expect(updated.tidyUpTimeOfDay).toBe("03:00");

      yield* harness.callTool("bot_update", { botId: created.id, paused: false });

      const writeRes = yield* harness.callTool("bot_file_write", {
        botId: created.id,
        relativePath: "skills/review/SKILL.md",
        content: "# Review Skill\nCheck diffs carefully.\n",
      });
      expect(writeRes.isError).not.toBe(true);

      const filesRes = yield* harness.callTool("bot_file_list", { botId: created.id });
      const files = parseResult<{ files: Array<{ relativePath: string }> }>(filesRes);
      expect(files.files.map((f) => f.relativePath)).toContain("skills/review/SKILL.md");

      const readRes = yield* harness.callTool("bot_file_read", {
        botId: created.id,
        relativePath: "skills/review/SKILL.md",
      });
      const read = parseResult<{ content: string }>(readRes);
      expect(read.content).toContain("Check diffs carefully.");

      const routineRes = yield* harness.callTool("bot_routine_upsert", {
        botId: created.id,
        title: "Morning PR review queue",
        prompt: "Check open PRs.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      });
      expect(routineRes.isError).not.toBe(true);
      const routine = parseResult<{ id: string; nextRunAt: string | null }>(routineRes);
      expect(routine.nextRunAt).not.toBeNull();

      const updatedRoutineRes = yield* harness.callTool("bot_routine_upsert", {
        routineId: routine.id,
        botId: created.id,
        title: "Morning PR review queue",
        prompt: "Check open PRs.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "10:00", weekdays: [1, 2, 3, 4, 5] },
      });
      expect(updatedRoutineRes.isError).not.toBe(true);
      const updatedRoutine = parseResult<{ id: string; schedule: { timeOfDay?: string } }>(
        updatedRoutineRes,
      );
      expect(updatedRoutine.id).toBe(routine.id);
      expect(updatedRoutine.schedule.timeOfDay).toBe("10:00");

      const routinesRes = yield* harness.callTool("bot_routine_list", { botId: created.id });
      const routines = parseResult<{ routines: Array<{ id: string }> }>(routinesRes);
      expect(routines.routines.map((r) => r.id)).toContain(routine.id);

      const runRes = yield* harness.callTool("bot_routine_run", { routineId: routine.id });
      expect(runRes.isError).not.toBe(true);
      const ran = parseResult<{ status: string; threadId: string | null }>(runRes);
      expect(ran.status).toBe("succeeded");
      expect(ran.threadId).not.toBeNull();

      const delRoutineRes = yield* harness.callTool("bot_routine_delete", {
        routineId: routine.id,
      });
      expect(parseResult<{ deleted: boolean }>(delRoutineRes).deleted).toBe(true);

      const itemRes = yield* harness.callTool("bot_item_create", {
        botId: created.id,
        title: "Review PR #42",
        summary: "Auth changes",
      });
      const item = parseResult<{ id: string }>(itemRes);

      const itemsRes = yield* harness.callTool("bot_item_list", { botId: created.id });
      expect(
        parseResult<{ items: Array<{ id: string }> }>(itemsRes).items.map((i) => i.id),
      ).toContain(item.id);

      const delItemRes = yield* harness.callTool("bot_item_delete", { itemId: item.id });
      expect(parseResult<{ deleted: boolean }>(delItemRes).deleted).toBe(true);

      const groupRes = yield* harness.callTool("bot_group_create", {
        name: "Engineering Delivery",
        memberBotIds: [created.id],
      });
      expect(groupRes.isError).not.toBe(true);
      const group = parseResult<{ id: string; name: string }>(groupRes);

      const updatedGroupRes = yield* harness.callTool("bot_group_update", {
        groupId: group.id,
        name: "Delivery Crew",
      });
      expect(parseResult<{ name: string }>(updatedGroupRes).name).toBe("Delivery Crew");

      const sendGroupRes = yield* harness.callTool("bot_group_send", {
        groupId: group.id,
        body: "@pr-review say hello",
      });
      expect(sendGroupRes.isError).not.toBe(true);

      const messagesRes = yield* harness.callTool("bot_group_messages", { groupId: group.id });
      expect(parseResult<{ messages: Array<{ body: string }> }>(messagesRes).messages).toHaveLength(
        1,
      );

      const delGroupRes = yield* harness.callTool("bot_group_delete", { groupId: group.id });
      expect(parseResult<{ deleted: boolean }>(delGroupRes).deleted).toBe(true);

      const delBotRes = yield* harness.callTool("bot_delete", {
        botId: created.id,
        removeHomeDirectory: true,
      });
      expect(parseResult<{ deleted: boolean }>(delBotRes).deleted).toBe(true);
    }).pipe(Effect.provide(harness.serverLayer));
  });

  it.effect("enforces full-access guards on mutating bot tools and allows reads", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const readAllowed = yield* harness.callTool("bot_list", {}, supervisedScope);
      expect(readAllowed.isError).not.toBe(true);

      const createRefused = yield* harness.callTool(
        "bot_create",
        { name: "Blocked Bot" },
        supervisedScope,
      );
      expect(createRefused.isError).toBe(true);
      expect(parseResult<{ code: string }>(createRefused).code).toBe("capability_denied");

      const readOnlyRefused = yield* harness.callTool(
        "bot_create",
        { name: "Blocked Bot" },
        readOnlyClientScope,
      );
      expect(readOnlyRefused.isError).toBe(true);
      expect(parseResult<{ code: string }>(readOnlyRefused).code).toBe("capability_denied");
    }).pipe(Effect.provide(harness.serverLayer));
  });

  it.effect("forwards bot tools targeting a linked environment", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const remoteList = yield* harness.callTool("bot_list", { environmentId: remoteEnvId });
      expect(remoteList.isError).not.toBe(true);
      expect(harness.forwardedCalls).toHaveLength(1);
      expect(harness.forwardedCalls[0]?.tool).toBe("bot_list");
      expect(harness.forwardedCalls[0]?.environmentId).toBe(remoteEnvId);

      const localList = yield* harness.callTool("bot_list", { environmentId: localEnvId });
      expect(localList.isError).not.toBe(true);
      expect(harness.forwardedCalls).toHaveLength(1);
    }).pipe(Effect.provide(harness.serverLayer));
  });
});
