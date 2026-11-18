// @effect-diagnostics-next-line nodeBuiltinImport:off -- the blocked row's key needs a synchronous SHA-256.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  type OrchestrationV2LinkedSender,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { capNotificationDetail } from "./ContextHandoffDelivery.ts";
import type * as ThreadManagement from "./ThreadManagementService.ts";

export const AGENT_MESSAGES_BLOCKED = "The owner has blocked messages from other threads";

const BLOCKED_TEXT_LIMIT = 2_000;

type Thread = Pick<OrchestrationV2ThreadShell, "id" | "title" | "lineage" | "delegatedFrom">;

interface Dependencies {
  readonly threads: Pick<
    ThreadManagement.ThreadManagementService["Service"],
    "getThreadShell" | "dispatch"
  >;
  readonly settings: Pick<ServerSettings.ServerSettingsService["Service"], "getSettings">;
}

/** Who put the text there: a thread here, or a linked environment's client and the thread it named. */
export type AgentMessageSender =
  | { readonly threadId: ThreadId }
  | {
      readonly linked: {
        readonly sessionId: string;
        readonly label: string;
        readonly from?: OrchestrationV2LinkedSender | undefined;
      };
    };

/** A thread scope is that thread; a linked client is its link; the owner's own client is no sender. */
export const agentMessageSenderOf = (scope: McpInvocationScope): AgentMessageSender | undefined =>
  scope.thread !== undefined
    ? { threadId: scope.thread.threadId }
    : scope.client?.linked === true
      ? {
          linked: {
            sessionId: scope.client.sessionId,
            label: scope.client.label,
            from: scope.client.senderThread,
          },
        }
      : undefined;

export class AgentMessageBlockedError extends Schema.TaggedError<AgentMessageBlockedError>()(
  "AgentMessageBlockedError",
  {},
) {
  override get message(): string {
    return AGENT_MESSAGES_BLOCKED;
  }
}

export class AgentMessagePolicyUnavailableError extends Schema.TaggedError<AgentMessagePolicyUnavailableError>()(
  "AgentMessagePolicyUnavailableError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const failure = (detail: string) => new AgentMessagePolicyUnavailableError({ detail });

/**
 * Under the `block` policy, refuses text an agent puts into a thread outside its own delegation
 * tree and records one row on that thread saying what was attempted. `attempted` reads after
 * "blocked", as in "a message". A thread, the tasks it delegated and, for a task delegated from a
 * linked environment, the thread that delegated it are one tree; forks and side chats are not.
 */
export const makeRefuseBlockedSender = ({ threads, settings }: Dependencies) =>
  Effect.fn("AgentMessagePolicy.refuseBlockedSender")(function* (
    from: AgentMessageSender | undefined,
    input: { readonly threadId: ThreadId; readonly attempted: string; readonly text: string },
  ) {
    // The owner's own MCP client is not a thread.
    if (from === undefined) return;
    // A policy that cannot be read refuses: allowing here would let a failed read lift the block.
    const policy = (yield* settings.getSettings.pipe(
      Effect.mapError(() => failure("The message policy could not be read.")),
    )).agentMessagePolicy;
    if (policy !== "block") return;
    const shell = (threadId: ThreadId) =>
      threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(() => failure(`Unable to read thread ${threadId}.`)));
    // The top of a delegation tree: forks and side chats start their own.
    const delegationRoot = Effect.fnUntraced(function* (thread: Thread) {
      let current = thread;
      const seen = new Set<ThreadId>();
      while (
        current.lineage.relationshipToParent === "subagent" &&
        current.lineage.parentThreadId !== null &&
        !seen.has(current.id)
      ) {
        seen.add(current.id);
        const parent = yield* shell(current.lineage.parentThreadId);
        if (parent === null) break;
        current = parent;
      }
      return current;
    });
    const target = yield* shell(input.threadId);
    // The caller's own lookup reports a missing thread.
    if (target === null) return;
    const targetRoot = yield* delegationRoot(target);
    let sender: { readonly key: string; readonly title: string };
    if ("threadId" in from) {
      if (from.threadId === target.id) return;
      const caller = yield* shell(from.threadId);
      if (caller !== null && (yield* delegationRoot(caller)).id === targetRoot.id) return;
      sender = { key: from.threadId, title: caller?.title ?? from.threadId };
    } else {
      const named = from.linked.from;
      // A parent on another machine messaging the task it delegated here is inside the tree.
      if (
        named !== undefined &&
        [target.delegatedFrom, targetRoot.delegatedFrom].some(
          (parent) =>
            parent != null &&
            parent.environmentId === named.environmentId &&
            parent.threadId === named.threadId,
        )
      ) {
        return;
      }
      sender = {
        key:
          named === undefined
            ? `link:${from.linked.sessionId}`
            : `${named.environmentId}:${named.threadId}`,
        title: named?.title ?? from.linked.label,
      };
    }
    // Keyed by what was attempted, so an agent retrying the same text adds no rows.
    const key = NodeCrypto.createHash("sha256")
      .update([sender.key, target.id, input.attempted, input.text].join("\0"))
      .digest("hex");
    yield* threads
      .dispatch({
        type: "thread.notice.record",
        commandId: CommandId.make(`server:agent-message-blocked:${key}`),
        threadId: target.id,
        notification: {
          source: { kind: "system" },
          outcome: "cancelled",
          summary: `T3 Code blocked ${input.attempted} from ${sender.title} (other threads are blocked in Settings)`,
          ...(input.text === ""
            ? {}
            : { detail: capNotificationDetail(input.text, BLOCKED_TEXT_LIMIT) }),
        },
      })
      .pipe(Effect.mapError(() => failure("The blocked message could not be recorded.")));
    return yield* new AgentMessageBlockedError();
  });
