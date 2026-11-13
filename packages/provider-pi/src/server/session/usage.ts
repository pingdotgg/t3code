/**
 * Pi token usage accounting and live usage reporting.
 */
import {
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "../rpc.ts";
import {
  PI_INHERIT_MODEL_SLUG,
  PI_PROVIDER,
  STREAM_FLUSH_MS,
  PI_REQUEST_TIMEOUT_MS,
  PI_SESSION_TIMEOUT_MS,
  PI_UNSOLICITED_ACTIVITY_ERROR,
  SETTLE_PROBE_MAX_ATTEMPTS,
  SETTLE_PROBE_RETRY_DELAY,
  PI_THINKING_LEVELS,
  PI_COMPACTING_PROMPT_REJECTION,
  PiProviderCapabilitiesV2,
  contentText,
  piToolOutput,
  providerRef,
  compactionTitle,
  piApprovalRequestKind,
} from "../adapter.ts";
import type {
  PiAdapterV2Options,
  PiStreamItemState,
  PiCompactionStatus,
  PiCompactionState,
  PiProviderRetryState,
  ActivePiTurn,
  PiTurnTreeRefs,
  PendingPiPrompt,
  PiPromptSend,
  PiThreadState,
  PiWake,
} from "../adapter.ts";
import { protocolError } from "./protocol.ts";
import type { State } from "./base.ts";
import type { Emitters } from "./emitters.ts";

export const makeUsage = (deps: State & Emitters) => {
  const {
    now,
    request,
  } = deps;
  const m = deps.mutable;
  const tokenUsageFromStats = (
    stats: unknown,
    fallbackUsedTokens: number | null,
    updatedAt: DateTime.Utc,
  ): OrchestrationV2ProviderTurnTokenUsage | undefined => {
    const contextUsage = recordField(stats, "contextUsage");
    const maxTokens = deps.nonNegativeInteger(contextUsage, "contextWindow");
    const usedTokens =
      deps.nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
    if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0)
      return undefined;

    const totals = recordField(stats, "tokens");
    const inputTokens = deps.nonNegativeInteger(totals, "input");
    const cachedInputTokens = deps.nonNegativeInteger(totals, "cacheRead");
    const outputTokens = deps.nonNegativeInteger(totals, "output");
    return {
      usedTokens,
      maxTokens,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      updatedAt: DateTime.formatIso(updatedAt),
    };
  };

  const readTokenUsage = (fallbackUsedTokens: number | null, updatedAt: DateTime.Utc) =>
    request({ type: "get_session_stats" }, 2_000).pipe(
      Effect.map((stats) => tokenUsageFromStats(stats, fallbackUsedTokens, updatedAt)),
      Effect.orElseSucceed(() => undefined),
    );

  const reportLiveUsage =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (turn: ActivePiTurn, usage: unknown) {
      const usedTokens = deps.nonNegativeInteger(usage, "totalTokens");
      if (
        usedTokens === undefined ||
        usedTokens === 0 ||
        usedTokens === turn.lastLiveUsedTokens ||
        m.contextWindow === null ||
        m.contextWindow === 0
      ) {
        return;
      }
      turn.lastLiveUsedTokens = usedTokens;
      const inputTokens = deps.nonNegativeInteger(usage, "input");
      const cachedInputTokens = deps.nonNegativeInteger(usage, "cacheRead");
      const outputTokens = deps.nonNegativeInteger(usage, "output");
      const updatedAt = yield* DateTime.now;
      yield* deps.emit({
        type: "provider_turn.updated",
        driver: PI_PROVIDER,
        threadId: turn.turnInput.threadId,
        providerTurn: {
          ...turn.providerTurn,
          tokenUsage: {
            usedTokens,
            maxTokens: m.contextWindow,
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            updatedAt: DateTime.formatIso(updatedAt),
          },
        },
      });
    });

  return { tokenUsageFromStats, readTokenUsage, reportLiveUsage };
};

export type Usage = ReturnType<typeof makeUsage>;
