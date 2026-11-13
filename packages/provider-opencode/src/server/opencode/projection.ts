/**
 * Projection of native OpenCode sessions, errors and SDK responses into T3 shapes.
 */
import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part as OpenCodePart,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  Session as OpenCodeSession,
  Todo as OpenCodeTodo,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as OpenCodeRuntime from "../OpenCodeRuntime.ts";
import { readableProviderErrorMessage } from "../providerErrorMessage.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  dateTimeFromEpoch,
  nativeThreadId,
  recordString,
  recordValue,
} from "./protocol.ts";
import {
  OPENCODE_PROVIDER,
} from "./provider.ts";
import type {
  ActiveOpenCodeTurn,
} from "./types.ts";
import type {
  TerminalTurnStatus,
} from "./usage.ts";

export function makeProviderThread(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly nativeSession: OpenCodeSession;
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  const createdAt = dateTimeFromEpoch(input.nativeSession.time.created, input.now);
  return {
    id: input.idAllocator.derive.providerThread({
      driver: OPENCODE_PROVIDER,
      nativeThreadId: input.nativeSession.id,
    }),
    driver: OPENCODE_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      driver: OPENCODE_PROVIDER,
      nativeId: input.nativeSession.id,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt,
    updatedAt: dateTimeFromEpoch(input.nativeSession.time.updated, input.now),
  };
}

export function providerRef(nativeId: string, strength: "strong" | "weak" = "strong") {
  return {
    driver: OPENCODE_PROVIDER,
    nativeId,
    strength,
  } satisfies OrchestrationV2ProviderRef;
}

export function openCodeErrorMessage(event: Extract<OpenCodeEvent, { type: "session.error" }>): string {
  const error = event.properties.error;
  if (error === undefined) return "OpenCode session failed without an error payload.";
  const statusCode = recordValue(error.data, "statusCode");
  return (
    readableProviderErrorMessage(
      recordString(error.data, "message"),
      typeof statusCode === "number" ? statusCode : undefined,
      recordString(error.data, "responseBody"),
    ) ?? error.name
  );
}

export function terminalStatusForError(
  event: Extract<OpenCodeEvent, { type: "session.error" }>,
  turn: ActiveOpenCodeTurn,
): TerminalTurnStatus {
  return turn.interrupted || isMessageAbortedError(event) ? "interrupted" : "failed";
}

export function isMessageAbortedError(event: Extract<OpenCodeEvent, { type: "session.error" }>): boolean {
  return event.properties.error?.name === "MessageAbortedError";
}

export function isOpenCodeNotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const record = node as Record<string, unknown>;

    const response = record.response;
    const statuses = [
      record.status,
      record.statusCode,
      response !== null && typeof response === "object"
        ? (response as { readonly status?: unknown }).status
        : undefined,
    ].filter((status): status is number => typeof status === "number");
    if (statuses.includes(404)) {
      return true;
    }
    if (statuses.length > 0) {
      continue;
    }

    const name = record.name;
    if (typeof name === "string" && name.toLowerCase() === "notfounderror") {
      return true;
    }

    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }
  return false;
}

export function unwrapData<A>(operation: string, result: { readonly data?: A }): NonNullable<A> {
  if (result.data === undefined) {
    throw new OpenCodeRuntime.OpenCodeRuntimeError({
      operation,
      detail: `OpenCode ${operation} returned no response payload.`,
    });
  }
  return result.data as NonNullable<A>;
}
