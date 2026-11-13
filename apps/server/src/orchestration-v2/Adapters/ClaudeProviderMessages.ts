// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import type { SDKAssistantMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { isCompactionCommandMessage, OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import type {
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ProviderInstanceId,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Option from "effect/Option";

import * as Schema from "effect/Schema";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { ClaudeProviderCapabilitiesV2 } from "./ClaudeProviderIdentity.ts";

export function providerSession(input: {
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string | null;
  readonly model: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CLAUDE_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    status: "ready",
    cwd: input.cwd ?? process.cwd(),
    model: input.model,
    capabilities: ClaudeProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

export function textFromClaudeContent(content: SDKAssistantMessage["message"]["content"]): string {
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

// Claude 5.1+ emits at most one pre-tool text block as thinking; treat only a second consecutive thinking block as text.
export function claudeWritesUpdatesAsThinking(model: string): boolean {
  const match = /claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?!\d)/u.exec(model);
  if (match === null) return false;
  const major = Number(match[1]);
  return major > 5 || (major === 5 && Number(match[2] ?? 0) >= 1);
}

// In SDK mode, /goal appears only in transcripts: command output names it and Stop hooks report unmet checks.
export const CLAUDE_GOAL_SET_PREFIX = "Goal set: ";
export const CLAUDE_GOAL_ACTIVE =
  /^Goal active: ([\s\S]+?) \((?:not yet evaluated|(\d+) turns?)\)/u;

export function nextClaudeGoal(
  current: OrchestrationV2ProviderGoal | null,
  message: SDKMessage,
): OrchestrationV2ProviderGoal | null | undefined {
  if (message.type === "assistant") {
    if (message.parent_tool_use_id !== null || message.message.model !== "<synthetic>") {
      return undefined;
    }
    const text = textFromClaudeContent(message.message.content).trim();
    if (text.startsWith(CLAUDE_GOAL_SET_PREFIX)) {
      const objective = text.slice(CLAUDE_GOAL_SET_PREFIX.length).trim();
      return objective.length === 0 ? undefined : { objective, status: "active", checks: 0 };
    }
    if (text.startsWith("Goal cleared: ") || text.startsWith("No goal set")) return null;
    const active = CLAUDE_GOAL_ACTIVE.exec(text);
    if (active?.[1] === undefined) return undefined;
    return {
      ...(current?.objective === active[1] ? current : {}),
      objective: active[1],
      status: "active",
      checks: Number(active[2] ?? 0),
    };
  }
  if (
    message.type !== "user" ||
    message.parent_tool_use_id !== null ||
    message.isSynthetic !== true ||
    current === null
  ) {
    return undefined;
  }
  const prefix = `Stop hook feedback:\n[${current.objective}]: `;
  const content = message.message.content;
  const text =
    typeof content === "string"
      ? content
      : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  if (!text.startsWith(prefix)) return undefined;
  return {
    ...current,
    status: "active",
    checks: (current.checks ?? 0) + 1,
    lastCheck: text.slice(prefix.length).trim(),
  };
}

/** The CLI confirms a goal change as a synthetic reply; the goal row shows that change instead. */
export function isClaudeGoalAcknowledgement(message: SDKMessage): boolean {
  if (
    message.type !== "assistant" ||
    message.parent_tool_use_id !== null ||
    message.message.model !== "<synthetic>"
  ) {
    return false;
  }
  const text = textFromClaudeContent(message.message.content).trim();
  return text.startsWith(CLAUDE_GOAL_SET_PREFIX) || text.startsWith("Goal cleared: ");
}

export const providerGoalsEqual = Schema.toEquivalence(Schema.NullOr(OrchestrationV2ProviderGoal));

export function normalizeClaudeResultText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function assistantTextFromSdkMessage(
  message: SDKMessage,
): { readonly nativeItemId: string; readonly text: string } | null {
  if (message.type !== "assistant") {
    return null;
  }
  return {
    nativeItemId: message.uuid,
    text: textFromClaudeContent(message.message.content),
  };
}

export function resultTextFromSdkMessage(
  message: SDKMessage,
): { readonly nativeItemId: string; readonly text: string } | null {
  if (message.type !== "result" || message.subtype !== "success") {
    return null;
  }
  return {
    nativeItemId: message.uuid,
    text: message.result,
  };
}

export function makeProviderThread(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly nativeThreadId: string;
  readonly forkedFrom?: NonNullable<OrchestrationV2ProviderThread["forkedFrom"]>;
  readonly nativeMetadata?: NonNullable<OrchestrationV2ProviderThread["nativeMetadata"]>;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CLAUDE_PROVIDER,
      nativeThreadId: input.nativeThreadId,
    }),
    driver: CLAUDE_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      driver: CLAUDE_PROVIDER,
      nativeId: input.nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    ...(input.nativeMetadata === undefined ? {} : { nativeMetadata: input.nativeMetadata }),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export const decodeClaudeTranscriptLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
);

export const isClaudeConversationLine = (line: string): boolean =>
  Option.match(decodeClaudeTranscriptLine(line), {
    onNone: () => false,
    onSome: (entry) => entry.type === "user" || entry.type === "assistant",
  });

export const getNativeThreadId = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
) {
  const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
  if (nativeThreadId === undefined || nativeThreadId === null) {
    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CLAUDE_PROVIDER,
      detail: `Provider thread ${providerThread.id} is missing a native Claude session id.`,
    });
  }
  return nativeThreadId;
});

export const isSyntheticClaudeTurnId = (nativeTurnId: string): boolean =>
  nativeTurnId.startsWith("turn:");

export const claudeTurnCursor = (turn: OrchestrationV2ProviderTurn): string | null => {
  const ref = turn.nativeTurnRef;
  return ref !== null &&
    ref.driver === CLAUDE_PROVIDER &&
    ref.nativeId !== null &&
    !isSyntheticClaudeTurnId(ref.nativeId)
    ? ref.nativeId
    : null;
};

export const isTerminalProviderTurn = (turn: OrchestrationV2ProviderTurn): boolean =>
  turn.status === "completed" ||
  turn.status === "interrupted" ||
  turn.status === "failed" ||
  turn.status === "cancelled";

export const getNativeConversationHeadId = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
) {
  const nativeHeadRef = providerThread.nativeConversationHeadRef;
  if (nativeHeadRef === null) {
    return undefined;
  }
  if (nativeHeadRef.driver !== CLAUDE_PROVIDER) {
    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CLAUDE_PROVIDER,
      detail: `Provider thread ${providerThread.id} has a non-Claude native conversation head reference.`,
    });
  }
  if (nativeHeadRef.nativeId === null) {
    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CLAUDE_PROVIDER,
      detail: `Provider thread ${providerThread.id} has a Claude native conversation head reference without a native id.`,
    });
  }
  return nativeHeadRef.nativeId;
});

export const resolveClaudeForkUpToMessageId = Effect.fn("ClaudeAdapterV2.resolveForkUpToMessageId")(
  function* (input: ProviderAdapter.ProviderAdapterV2ForkThreadInput) {
    if (input.providerTurnId === undefined || input.sourceProviderTurns === undefined) {
      return undefined;
    }

    const sourceTurns = input.sourceProviderTurns
      .filter((turn) => turn.providerThreadId === input.sourceProviderThread.id)
      .toSorted((left, right) => left.ordinal - right.ordinal);
    const boundaryIndex = sourceTurns.findIndex((turn) => turn.id === input.providerTurnId);
    if (boundaryIndex < 0) {
      return yield* new ProviderAdapter.ProviderAdapterForkThreadError({
        driver: CLAUDE_PROVIDER,
        providerThreadId: input.sourceProviderThread.id,
        cause: `Cannot fork Claude thread from provider turn ${input.providerTurnId}: source turn was not found in provider thread ${input.sourceProviderThread.id}.`,
      });
    }

    const boundaryNativeId = sourceTurns[boundaryIndex]?.nativeTurnRef?.nativeId;
    if (
      boundaryNativeId !== undefined &&
      boundaryNativeId !== null &&
      !isSyntheticClaudeTurnId(boundaryNativeId)
    ) {
      return boundaryNativeId;
    }

    const terminalTurnsAfterBoundary = sourceTurns
      .slice(boundaryIndex + 1)
      .filter(isTerminalProviderTurn);
    if (terminalTurnsAfterBoundary.length === 0) {
      // Rollback pins the head but leaves the rolled-back turns in Claude's transcript.
      return yield* getNativeConversationHeadId(input.sourceProviderThread);
    }

    return yield* new ProviderAdapter.ProviderAdapterForkThreadError({
      driver: CLAUDE_PROVIDER,
      providerThreadId: input.sourceProviderThread.id,
      cause: `Cannot fork Claude thread from prior provider turn ${input.providerTurnId}: no SDK assistant message cursor was recorded for that turn.`,
    });
  },
);

export const resolveClaudeRollbackResumeSessionAt = Effect.fn(
  "ClaudeAdapterV2.resolveRollbackResumeSessionAt",
)(function* (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) {
  switch (input.target.type) {
    case "thread_start":
      return input.providerThread.nativeMetadata?.forkHeadMessageId ?? null;
    case "provider_turn": {
      const target = input.target;
      if (target.providerTurn.providerThreadId !== input.providerThread.id) {
        return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
          driver: CLAUDE_PROVIDER,
          providerThreadId: input.providerThread.id,
          cause: `Cannot roll back Claude thread ${input.providerThread.id} to provider turn ${target.providerTurn.id}: target turn belongs to provider thread ${target.providerTurn.providerThreadId}.`,
        });
      }

      const cursor = claudeTurnCursor(target.providerTurn);
      if (cursor !== null) {
        return cursor;
      }

      const providerTurnsAfterTarget = input.providerThreadTurns.filter(
        (turn) => turn.ordinal > target.providerTurn.ordinal && isTerminalProviderTurn(turn),
      );
      if (providerTurnsAfterTarget.length === 0) {
        return null;
      }

      // Only compaction can be omitted without dropping a retained user prompt.
      if (target.message !== undefined && isCompactionCommandMessage(target.message)) {
        const earlierTurn = input.providerThreadTurns
          .filter((turn) => turn.ordinal < target.providerTurn.ordinal)
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .at(-1);
        const earlierCursor = earlierTurn === undefined ? null : claudeTurnCursor(earlierTurn);
        if (earlierCursor != null) {
          return earlierCursor;
        }
      }

      return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
        driver: CLAUDE_PROVIDER,
        providerThreadId: input.providerThread.id,
        cause: `Cannot roll back Claude thread ${input.providerThread.id} to provider turn ${target.providerTurn.id}: no SDK assistant message cursor was recorded for that turn.`,
      });
    }
  }
});
