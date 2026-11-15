import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeTaskId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentMessaging from "./AgentMessagingService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const projectId = ProjectId.make("project-agent-messaging");
const rootThreadId = ThreadId.make("thread-agent-root");
const senderThreadId = ThreadId.make("thread-agent-sender");
const recipientThreadId = ThreadId.make("thread-agent-recipient");
const outsiderRootThreadId = ThreadId.make("thread-outsider-root");
const outsiderThreadId = ThreadId.make("thread-outsider-child");
const senderTaskId = NodeId.make("agent-sender");
const recipientTaskId = NodeId.make("agent-recipient");
const outsiderTaskId = NodeId.make("agent-outsider");
const senderAgentId = RuntimeTaskId.make(senderTaskId);
const recipientAgentId = RuntimeTaskId.make(recipientTaskId);
const outsiderAgentId = RuntimeTaskId.make(outsiderTaskId);
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

const shell = (input: {
  readonly id: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly parentThreadId: ThreadId | null;
  readonly relationshipToParent: "subagent" | null;
}): OrchestrationV2ThreadShell =>
  ({
    id: input.id,
    projectId,
    title: input.title,
    modelSelection: { instanceId: input.instanceId, model: input.model },
    lineage: {
      parentThreadId: input.parentThreadId,
      relationshipToParent: input.relationshipToParent,
      rootThreadId:
        input.id === outsiderRootThreadId || input.id === outsiderThreadId
          ? outsiderRootThreadId
          : rootThreadId,
    },
    forkedFrom:
      input.id === senderThreadId
        ? { type: "node", nodeId: senderTaskId }
        : input.id === recipientThreadId
          ? { type: "node", nodeId: recipientTaskId }
          : input.id === outsiderThreadId
            ? { type: "node", nodeId: outsiderTaskId }
            : null,
    status: "running",
    activityRunStatus: "running",
  }) as unknown as OrchestrationV2ThreadShell;

const senderShell = shell({
  id: senderThreadId,
  title: "Sender",
  instanceId: codex,
  model: "gpt-5.4",
  parentThreadId: rootThreadId,
  relationshipToParent: "subagent",
});
const recipientShell = shell({
  id: recipientThreadId,
  title: "Recipient",
  instanceId: claude,
  model: "claude-sonnet-4-6",
  parentThreadId: rootThreadId,
  relationshipToParent: "subagent",
});
const shells = [
  shell({
    id: rootThreadId,
    title: "Parent",
    instanceId: codex,
    model: "gpt-5.4",
    parentThreadId: null,
    relationshipToParent: null,
  }),
  senderShell,
  recipientShell,
  shell({
    id: outsiderRootThreadId,
    title: "Other parent",
    instanceId: codex,
    model: "gpt-5.4",
    parentThreadId: null,
    relationshipToParent: null,
  }),
  shell({
    id: outsiderThreadId,
    title: "Outsider",
    instanceId: codex,
    model: "gpt-5.4",
    parentThreadId: outsiderRootThreadId,
    relationshipToParent: "subagent",
  }),
];

const task = (input: {
  readonly id: NodeId;
  readonly parentThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}): OrchestrationV2Subagent =>
  ({
    id: input.id,
    threadId: input.parentThreadId,
    childThreadId: input.childThreadId,
    origin: "app_owned",
    title: input.title,
    providerInstanceId: input.instanceId,
    model: input.model,
    status: "running",
  }) as unknown as OrchestrationV2Subagent;

const rootTasks = [
  task({
    id: senderTaskId,
    parentThreadId: rootThreadId,
    childThreadId: senderThreadId,
    title: "Sender",
    instanceId: codex,
    model: "gpt-5.4",
  }),
  task({
    id: recipientTaskId,
    parentThreadId: rootThreadId,
    childThreadId: recipientThreadId,
    title: "Recipient",
    instanceId: claude,
    model: "claude-sonnet-4-6",
  }),
];

const activeProjection = (thread: OrchestrationV2ThreadShell): OrchestrationV2ThreadProjection =>
  ({
    thread,
    runs: [
      {
        id: RunId.make(`run-${thread.id}`),
        ordinal: 1,
        status: "running",
        providerInstanceId: thread.modelSelection.instanceId,
      },
    ],
    subagents: thread.id === rootThreadId ? rootTasks : [],
  }) as unknown as OrchestrationV2ThreadProjection;

const scope = (threadId: ThreadId, providerInstanceId: ProviderInstanceId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-agent-messaging"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  requestNamespace: `thread:${threadId}`,
  thread: { threadId, providerSessionId: `session-${threadId}`, providerInstanceId },
  client: undefined,
});

const makeThreadLayer = (readRootTasks = () => rootTasks) =>
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadRecords: (threadId) => {
      if (threadId === rootThreadId)
        return Effect.succeed({ ...activeProjection(shells[0]!), subagents: readRootTasks() });
      if (threadId === outsiderRootThreadId) {
        return Effect.succeed({
          ...activeProjection(shells[3]!),
          subagents: [
            task({
              id: outsiderTaskId,
              parentThreadId: outsiderRootThreadId,
              childThreadId: outsiderThreadId,
              title: "Outsider",
              instanceId: codex,
              model: "gpt-5.4",
            }),
          ],
        });
      }
      const thread = shells.find((entry) => entry.id === threadId);
      return thread === undefined
        ? Effect.die(`unexpected thread ${threadId}`)
        : Effect.succeed(activeProjection(thread));
    },
    listProjectThreads: () => Effect.succeed(shells),
    getShellSnapshot: (options) =>
      Effect.succeed({
        snapshotSequence: 0,
        threads: shells.filter((shell) => options?.threadIds?.includes(shell.id) ?? true),
        archivedThreads: [],
      } as never),
    sendToThread: (input) =>
      Effect.succeed({
        run: {
          id: RunId.make(`delivery-${input.threadId}`),
        },
        delivery: "steered",
      } as never),
  });

const serviceLayer = () => AgentMessaging.layer.pipe(Layer.provide(makeThreadLayer()));

describe("AgentMessagingService", () => {
  it.effect.each(["creation", "reverse"] as const)(
    "keeps a child's inbox and address across follow-up tasks in %s order",
    (order) =>
      Effect.gen(function* () {
        const original = {
          ...rootTasks[1]!,
          status: "completed" as const,
          result: "Original result",
          startedAt: DateTime.makeUnsafe("2026-10-10T12:00:00Z"),
        };
        const followup = {
          ...original,
          id: NodeId.make("agent-recipient-followup"),
          status: "running" as const,
          result: null,
          startedAt: DateTime.makeUnsafe("2026-10-10T12:01:00Z"),
        };
        let currentTasks = [rootTasks[0]!, original];
        const layer = AgentMessaging.layer.pipe(Layer.provide(makeThreadLayer(() => currentTasks)));
        yield* Effect.gen(function* () {
          const messaging = yield* AgentMessaging.AgentMessagingService;
          yield* messaging.send(scope(rootThreadId, codex), {
            messageId: "before-followup",
            targetAgentId: recipientAgentId,
            message: "Please inspect the importer.",
          });
          currentTasks =
            order === "creation"
              ? [rootTasks[0]!, original, followup]
              : [followup, original, rootTasks[0]!];
          const inbox = yield* messaging.inbox(scope(recipientThreadId, claude), {});
          assert.equal(inbox.agentId, recipientAgentId);
          assert.deepEqual(
            inbox.messages.map((message) => message.messageId),
            ["before-followup"],
          );
          const acknowledged = yield* messaging.inbox(scope(recipientThreadId, claude), {
            acknowledgeMessageIds: ["before-followup"],
          });
          assert.deepEqual(acknowledged.acknowledgedMessageIds, ["before-followup"]);
          assert.deepEqual(acknowledged.messages, []);
          const parentInbox = yield* messaging.inbox(scope(rootThreadId, codex), {});
          assert.isTrue(parentInbox.peers.some((peer) => peer.agentId === recipientAgentId));
          assert.isFalse(
            parentInbox.peers.some((peer) => peer.agentId === RuntimeTaskId.make(followup.id)),
          );
          const sent = yield* messaging.send(scope(rootThreadId, codex), {
            messageId: "after-followup",
            targetAgentId: recipientAgentId,
            message: "Please inspect the checkpoint too.",
          });
          assert.equal(sent.targetAgentId, recipientAgentId);
          const nextInbox = yield* messaging.inbox(scope(recipientThreadId, claude), {});
          assert.deepEqual(
            nextInbox.messages.map((message) => message.messageId),
            ["after-followup"],
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("persists send-to-inbox delivery across service restarts and acknowledges it", () =>
    Effect.gen(function* () {
      const sent = yield* Effect.gen(function* () {
        const messaging = yield* AgentMessaging.AgentMessagingService;
        return yield* messaging.send(scope(senderThreadId, codex), {
          messageId: "message-1",
          targetAgentId: recipientAgentId,
          message: "Please inspect the importer.",
        });
      }).pipe(Effect.provide(Layer.fresh(serviceLayer())));
      assert.equal(sent.status, "notified");
      assert.equal(sent.senderAgentId, senderAgentId);

      const inbox = yield* Effect.gen(function* () {
        const messaging = yield* AgentMessaging.AgentMessagingService;
        return yield* messaging.inbox(scope(recipientThreadId, claude), {});
      }).pipe(Effect.provide(Layer.fresh(serviceLayer())));
      assert.equal(inbox.messages.length, 1);
      assert.deepInclude(inbox.messages[0]!, {
        messageId: "message-1",
        senderAgentId,
        senderTitle: "Sender",
        message: "Please inspect the importer.",
      });
      assert.isString(inbox.messages[0]!.createdAt);
      assert.isTrue(inbox.peers.some((peer) => peer.agentId === senderAgentId));

      const acknowledged = yield* Effect.gen(function* () {
        const messaging = yield* AgentMessaging.AgentMessagingService;
        return yield* messaging.inbox(scope(recipientThreadId, claude), {
          acknowledgeMessageIds: ["message-1"],
        });
      }).pipe(Effect.provide(Layer.fresh(serviceLayer())));
      assert.deepEqual(acknowledged.acknowledgedMessageIds, ["message-1"]);
      assert.deepEqual(acknowledged.messages, []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects recipients outside the sender's delegation family", () =>
    Effect.gen(function* () {
      const messaging = yield* AgentMessaging.AgentMessagingService;
      const error = yield* messaging
        .send(scope(senderThreadId, codex), {
          messageId: "outside-family",
          targetAgentId: outsiderAgentId,
          message: "This must not cross roots.",
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "invalid_request");
    }).pipe(
      Effect.provide(
        serviceLayer().pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
  );

  it.effect("creates its table and index idempotently", () =>
    Effect.gen(function* () {
      yield* Effect.service(AgentMessaging.AgentMessagingService).pipe(
        Effect.provide(Layer.fresh(serviceLayer())),
      );
      yield* Effect.service(AgentMessaging.AgentMessagingService).pipe(
        Effect.provide(Layer.fresh(serviceLayer())),
      );
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE name IN (
          'orchestration_v2_agent_messages',
          'idx_orchestration_v2_agent_messages_inbox'
        )
      `;
      assert.equal(rows[0]?.count, 2);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
