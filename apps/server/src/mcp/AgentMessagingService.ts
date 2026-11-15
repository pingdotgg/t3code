// @effect-diagnostics-next-line nodeBuiltinImport:off -- stableId needs a synchronous SHA-256.
import * as NodeCrypto from "node:crypto";
import {
  type AgentInboxInput,
  type AgentInboxResult,
  type AgentSendInput,
  type AgentSendResult,
  CommandId,
  MessageId,
  OrchestratorMcpFailure,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  RuntimeTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { type McpInvocationScope, requireThreadScope } from "./McpInvocationContext.ts";

const MAX_PENDING_MESSAGES = 100;
const MAX_INBOX_MESSAGE_TEXT = 100_000;

interface AgentMessageRow {
  readonly message_id: string;
  readonly family_root_thread_id: string;
  readonly sender_thread_id: string;
  readonly sender_agent_id: string;
  readonly recipient_thread_id: string;
  readonly recipient_agent_id: string;
  readonly body: string;
  readonly delivery_state: "queued" | "notified";
  readonly delivery_run_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly acknowledged_at: string | null;
}

type AgentPeer = AgentInboxResult["peers"][number] & {
  readonly threadId: ThreadId;
};

interface AgentFamily {
  readonly rootThreadId: ThreadId;
  readonly projectId: OrchestrationV2ThreadShell["projectId"];
  readonly sender: AgentPeer;
  readonly members: ReadonlyArray<AgentPeer>;
}

export interface AgentMessagingServiceShape {
  readonly send: (
    scope: McpInvocationScope,
    input: AgentSendInput,
  ) => Effect.Effect<AgentSendResult, OrchestratorMcpFailure>;
  readonly inbox: (
    scope: McpInvocationScope,
    input: AgentInboxInput,
  ) => Effect.Effect<AgentInboxResult, OrchestratorMcpFailure>;
}

export class AgentMessagingService extends Context.Service<
  AgentMessagingService,
  AgentMessagingServiceShape
>()("t3/mcp/AgentMessagingService") {}

function failure(code: OrchestratorMcpFailure["code"], message: string) {
  return new OrchestratorMcpFailure({ code, message });
}

function peerStatus(
  status: OrchestrationV2Subagent["status"] | OrchestrationV2ThreadShell["status"],
): AgentPeer["status"] {
  switch (status) {
    case "pending":
    case "preparing":
    case "queued":
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "completed":
    case "idle":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "cancelled";
  }
}

function stableId(kind: "command" | "message", rootThreadId: ThreadId, messageId: string) {
  const digest = NodeCrypto.createHash("sha256")
    .update(`${rootThreadId}\0${messageId}`)
    .digest("hex");
  return `${kind}:agent-message:${digest}`;
}

const layerEffect = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_agent_messages (
      message_id TEXT NOT NULL,
      family_root_thread_id TEXT NOT NULL,
      sender_thread_id TEXT NOT NULL,
      sender_agent_id TEXT NOT NULL,
      recipient_thread_id TEXT NOT NULL,
      recipient_agent_id TEXT NOT NULL,
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('queued', 'notified')),
      delivery_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      acknowledged_at TEXT,
      PRIMARY KEY (family_root_thread_id, message_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_v2_agent_messages_inbox
    ON orchestration_v2_agent_messages(
      family_root_thread_id, recipient_agent_id, acknowledged_at, created_at
    )
  `;

  const readFamily = Effect.fn("AgentMessagingService.readFamily")(function* (
    scope: McpInvocationScope,
  ) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* failure(
        "capability_denied",
        "This MCP credential does not grant orchestration capabilities.",
      );
    }
    const caller = (yield* requireThreadScope(scope, "Agent messaging")).thread;
    const senderRecords = yield* threads
      .getThreadRecords(caller.threadId, ["runs"])
      .pipe(
        Effect.mapError(() =>
          failure("orchestration_error", "Unable to resolve the sending agent."),
        ),
      );
    const activeRun = ThreadManagement.latestActiveRun(senderRecords);
    if (activeRun === undefined || activeRun.providerInstanceId !== caller.providerInstanceId) {
      return yield* failure(
        "parent_not_active",
        "Agent messaging requires an active run owned by this MCP provider session.",
      );
    }

    const projectThreads = yield* threads
      .listProjectThreads({
        projectId: senderRecords.thread.projectId,
        includeSubagents: true,
      })
      .pipe(
        Effect.mapError(() =>
          failure("orchestration_error", "Unable to resolve the delegation family."),
        ),
      );
    const byThreadId = new Map(projectThreads.map((thread) => [thread.id, thread] as const));
    const senderShell = byThreadId.get(caller.threadId);
    if (senderShell === undefined) {
      return yield* failure("thread_not_found", "The sending agent thread is not available.");
    }

    const familyRoot = (
      start: Pick<OrchestrationV2ThreadShell, "id" | "lineage">,
    ): ThreadId | undefined => {
      let current = start;
      const seen = new Set<ThreadId>();
      while (
        current.lineage.relationshipToParent === "subagent" &&
        current.lineage.parentThreadId !== null
      ) {
        if (seen.has(current.id)) return undefined;
        seen.add(current.id);
        const parent = byThreadId.get(current.lineage.parentThreadId);
        if (parent === undefined) return undefined;
        current = parent;
      }
      return current.id;
    };
    const rootThreadId = familyRoot(senderShell);
    if (rootThreadId === undefined) {
      return yield* failure("orchestration_error", "The delegation family lineage is incomplete.");
    }
    // The project listing is lean; only the family needs full shells.
    const familyShells = yield* threads
      .getShellSnapshot({
        location: "active",
        threadIds: projectThreads
          .filter((thread) => familyRoot(thread) === rootThreadId)
          .map((thread) => thread.id),
      })
      .pipe(
        Effect.map((snapshot) => snapshot.threads),
        Effect.mapError(() =>
          failure("orchestration_error", "Unable to resolve the delegation family."),
        ),
      );
    const familyById = new Map(familyShells.map((thread) => [thread.id, thread] as const));
    const parentThreadIds = new Set(
      familyShells.flatMap((thread) =>
        thread.lineage.relationshipToParent === "subagent" && thread.lineage.parentThreadId !== null
          ? [thread.lineage.parentThreadId]
          : [],
      ),
    );
    const parentTasks = yield* Effect.forEach(
      [...parentThreadIds],
      (threadId) =>
        threads.getThreadRecords(threadId, ["subagents"]).pipe(
          Effect.map((records) => records.subagents),
          Effect.mapError(() =>
            failure("orchestration_error", "Unable to resolve delegation addresses."),
          ),
        ),
      { concurrency: "unbounded" },
    );
    // A child keeps its original delegation address when follow-up work adds tasks.
    const taskByChildThread = new Map(
      parentTasks
        .flat()
        .filter((task): task is OrchestrationV2Subagent & { readonly childThreadId: ThreadId } => {
          const child =
            task.childThreadId === null ? undefined : familyById.get(task.childThreadId);
          return (
            task.origin === "app_owned" &&
            task.childThreadId !== null &&
            child?.forkedFrom?.type === "node" &&
            child.forkedFrom.nodeId === task.id
          );
        })
        .map((task) => [task.childThreadId, task] as const),
    );
    const members = familyShells.flatMap((thread): ReadonlyArray<AgentPeer> => {
      if (thread.id === rootThreadId) {
        return [
          {
            threadId: thread.id,
            agentId: RuntimeTaskId.make(thread.id),
            title: thread.title,
            providerInstanceId: thread.modelSelection.instanceId,
            model: thread.modelSelection.model,
            status: peerStatus(thread.activityRunStatus ?? thread.status),
          },
        ];
      }
      const task = taskByChildThread.get(thread.id);
      if (task === undefined) return [];
      return [
        {
          threadId: thread.id,
          agentId: RuntimeTaskId.make(task.id),
          title: task.title ?? thread.title,
          providerInstanceId: task.providerInstanceId,
          model: task.model ?? thread.modelSelection.model,
          status: peerStatus(task.status),
        },
      ];
    });
    const sender = members.find((member) => member.threadId === caller.threadId);
    if (sender === undefined) {
      return yield* failure("orchestration_error", "The sending agent has no delegation address.");
    }
    return {
      rootThreadId,
      projectId: senderRecords.thread.projectId,
      sender,
      members,
    } satisfies AgentFamily;
  });

  const selectMessage = (rootThreadId: ThreadId, messageId: string) =>
    sql<AgentMessageRow>`
      SELECT * FROM orchestration_v2_agent_messages
      WHERE family_root_thread_id = ${rootThreadId} AND message_id = ${messageId}
    `.pipe(Effect.map((rows) => rows[0]));

  const send: AgentMessagingServiceShape["send"] = Effect.fn("AgentMessagingService.send")(
    function* (scope, input) {
      const family = yield* readFamily(scope);
      const target = family.members.find((member) => member.agentId === input.targetAgentId);
      if (target === undefined) {
        return yield* failure("invalid_request", "Unknown target agent in this delegation family.");
      }
      if (target.agentId === family.sender.agentId) {
        return yield* failure("invalid_request", "Send messages to a teammate, not yourself.");
      }
      if (target.status === "failed" || target.status === "cancelled") {
        return yield* failure(
          "invalid_request",
          "Cancelled or failed agents cannot be restarted by a teammate.",
        );
      }

      const existing = yield* selectMessage(family.rootThreadId, input.messageId).pipe(
        Effect.mapError(() => failure("orchestration_error", "Unable to read the message outbox.")),
      );
      let message = existing;
      if (message === undefined) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const inserted = yield* sql<AgentMessageRow>`
          INSERT INTO orchestration_v2_agent_messages (
            message_id, family_root_thread_id, sender_thread_id, sender_agent_id,
            recipient_thread_id, recipient_agent_id, body, delivery_state,
            delivery_run_id, created_at, updated_at, acknowledged_at
          )
          SELECT ${input.messageId}, ${family.rootThreadId}, ${family.sender.threadId},
            ${family.sender.agentId}, ${target.threadId}, ${target.agentId}, ${input.message},
            'queued', NULL, ${now}, ${now}, NULL
          WHERE (
            SELECT COUNT(*) FROM orchestration_v2_agent_messages
            WHERE family_root_thread_id = ${family.rootThreadId}
              AND recipient_agent_id = ${target.agentId} AND acknowledged_at IS NULL
          ) < ${MAX_PENDING_MESSAGES}
          ON CONFLICT(family_root_thread_id, message_id) DO NOTHING
          RETURNING *
        `.pipe(
          Effect.mapError(() => failure("orchestration_error", "Unable to persist the message.")),
        );
        message =
          inserted[0] ??
          (yield* selectMessage(family.rootThreadId, input.messageId).pipe(
            Effect.mapError(() =>
              failure("orchestration_error", "Unable to read the persisted message."),
            ),
          ));
        if (message === undefined) {
          return yield* failure(
            "invalid_request",
            `The target inbox has ${MAX_PENDING_MESSAGES} pending messages.`,
          );
        }
      }
      if (
        message.sender_agent_id !== family.sender.agentId ||
        message.recipient_agent_id !== target.agentId ||
        message.body !== input.message
      ) {
        return yield* failure(
          "invalid_request",
          "This messageId was already used for different content.",
        );
      }

      if (message.delivery_state === "notified" && message.delivery_run_id !== null) {
        return {
          messageId: message.message_id,
          senderAgentId: RuntimeTaskId.make(message.sender_agent_id),
          targetAgentId: RuntimeTaskId.make(message.recipient_agent_id),
          status: "notified",
          deliveryRunId: RuntimeTaskId.make(message.delivery_run_id),
        };
      }

      const result = yield* threads
        .sendToThread({
          projectId: family.projectId,
          commandId: CommandId.make(stableId("command", family.rootThreadId, input.messageId)),
          threadId: target.threadId,
          senderThreadId: family.sender.threadId,
          messageId: MessageId.make(stableId("message", family.rootThreadId, input.messageId)),
          text: `[T3 agent message ${input.messageId} from ${family.sender.title} (${family.sender.agentId})]\n${input.message}\n\nRead pending messages and acknowledge this message after processing it with agent_inbox.`,
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          // The inbox owns this delivery; it is not another delegated work request.
          creationSource: "server",
        })
        .pipe(
          Effect.mapError(() =>
            failure(
              "orchestration_error",
              "The message was saved but its notice could not be sent.",
            ),
          ),
        );
      const deliveryState = result.delivery === "queued" ? "queued" : "notified";
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE orchestration_v2_agent_messages
        SET delivery_state = ${deliveryState}, delivery_run_id = ${result.run.id},
          updated_at = ${updatedAt}
        WHERE family_root_thread_id = ${family.rootThreadId}
          AND message_id = ${input.messageId}
      `.pipe(
        Effect.mapError(() =>
          failure("orchestration_error", "The message notice could not be recorded."),
        ),
      );
      return {
        messageId: input.messageId,
        senderAgentId: family.sender.agentId,
        targetAgentId: target.agentId,
        status: deliveryState,
        deliveryRunId: RuntimeTaskId.make(result.run.id),
      };
    },
  );

  const inbox: AgentMessagingServiceShape["inbox"] = Effect.fn("AgentMessagingService.inbox")(
    function* (scope, input) {
      const family = yield* readFamily(scope);
      const acknowledgedMessageIds: string[] = [];
      for (const messageId of new Set(input.acknowledgeMessageIds ?? [])) {
        const acknowledgedAt = DateTime.formatIso(yield* DateTime.now);
        const rows = yield* sql<{ readonly message_id: string }>`
          UPDATE orchestration_v2_agent_messages
          SET acknowledged_at = ${acknowledgedAt}, updated_at = ${acknowledgedAt}
          WHERE family_root_thread_id = ${family.rootThreadId}
            AND recipient_agent_id = ${family.sender.agentId}
            AND message_id = ${messageId} AND acknowledged_at IS NULL
          RETURNING message_id
        `.pipe(
          Effect.mapError(() =>
            failure("orchestration_error", "Unable to acknowledge the message."),
          ),
        );
        if (rows.length > 0) acknowledgedMessageIds.push(messageId);
      }

      const limit = input.limit ?? 50;
      const pending = yield* sql<AgentMessageRow>`
        SELECT * FROM orchestration_v2_agent_messages
        WHERE family_root_thread_id = ${family.rootThreadId}
          AND recipient_agent_id = ${family.sender.agentId} AND acknowledged_at IS NULL
        ORDER BY created_at ASC, message_id ASC LIMIT ${limit + 1}
      `.pipe(
        Effect.mapError(() => failure("orchestration_error", "Unable to read the message inbox.")),
      );
      const byAgentId = new Map(family.members.map((member) => [member.agentId, member] as const));
      const messages: AgentInboxResult["messages"][number][] = [];
      let textLength = 0;
      for (const message of pending.slice(0, limit)) {
        const senderTitle =
          byAgentId.get(RuntimeTaskId.make(message.sender_agent_id))?.title ?? "Unknown teammate";
        const entryLength =
          message.message_id.length +
          message.sender_agent_id.length +
          senderTitle.length +
          message.body.length +
          message.created_at.length;
        if (textLength + entryLength > MAX_INBOX_MESSAGE_TEXT) break;
        textLength += entryLength;
        messages.push({
          messageId: message.message_id,
          senderAgentId: RuntimeTaskId.make(message.sender_agent_id),
          senderTitle,
          message: message.body,
          createdAt: message.created_at,
        });
      }
      const peers = family.members.filter((member) => member.agentId !== family.sender.agentId);
      return {
        agentId: family.sender.agentId,
        peers: peers.slice(0, 50).map(({ threadId: _threadId, ...peer }) => peer),
        peersTruncated: peers.length > 50,
        messages,
        acknowledgedMessageIds,
        hasMore: pending.length > messages.length,
      };
    },
  );

  return AgentMessagingService.of({ send, inbox });
});

export const layer = Layer.effect(AgentMessagingService, layerEffect);
