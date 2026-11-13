// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import * as Context from "effect/Context";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import { claudeSignedOutMessage } from "../../provider/Drivers/ClaudeHome.ts";
import type { Deps as PrevDeps } from "./claudeSessionWakeBuffer.ts";
import { installWakeBuffer } from "./claudeSessionWakeBuffer.ts";
import type { ClaudeSdkFrame } from "./claudeSessionFrameTypes.ts";
import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import { claudeUsageLimitResetAt } from "./ClaudeApprovals.ts";
import { claudeWritesUpdatesAsThinking } from "./ClaudeProviderMessages.ts";
import { isClaudeBlockedAssistantRateLimit } from "./ClaudeApprovals.ts";
import { mergeClaudeStreamUsage } from "./ClaudeProviderIdentity.ts";
import type { ClaudeMessageUsage } from "./ClaudeProviderIdentity.ts";

export type Deps = PrevDeps & ReturnType<typeof installWakeBuffer>;

export const installFrameA = (s: Deps) => {
  const { adapterOptions, path, idAllocator } = s.env;
  const {
    now,
    pdfBudgets,
    emitProviderEvent,
    persistAttachmentBudget,
    emitContextUsage,
    resolveItemOrdinal,
    ensureReasoningBlock,
    reasoningDeltas,
    emitAssistantTextArtifacts,
  } = s;
  const handleFramePartA = Effect.fnUntraced(function* (frame: ClaudeSdkFrame) {
    const { message, liveQuery, context } = frame;
    if (message.type === "stream_event" && !message.parent_tool_use_id) {
      const event = message.event;
      const reasoning = context.reasoning;
      if (event.type === "message_start") {
        reasoning.messageId = event.message.id;
        reasoning.streamBlocks.clear();
        const usage: ClaudeMessageUsage | undefined = event.message.usage;
        context.streamUsage = usage === undefined ? null : { messageId: event.message.id, usage };
        if (usage !== undefined) yield* emitContextUsage(context, usage, true);
      } else if (event.type === "message_delta") {
        const usage: typeof event.usage | undefined = event.usage;
        const stream = context.streamUsage;
        if (stream?.usage && usage !== undefined) {
          stream.usage = mergeClaudeStreamUsage(stream.usage, usage);
          yield* emitContextUsage(context, stream.usage);
        }
      } else if (
        event.type === "content_block_start" &&
        event.content_block.type === "thinking" &&
        reasoning.messageId !== null
      ) {
        const index = reasoning.nextBlockIndex.get(reasoning.messageId) ?? 0;
        reasoning.nextBlockIndex.set(reasoning.messageId, index + 1);
        const itemId = `${reasoning.messageId}:thinking:${index}`;
        reasoning.streamBlocks.set(event.index, itemId);
        yield* ensureReasoningBlock(context, itemId);
        yield* reasoningDeltas.append({
          turnId: context.nativeTurnId,
          itemId,
          delta: event.content_block.thinking,
        });
      } else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
        const itemId = reasoning.streamBlocks.get(event.index);
        if (itemId !== undefined) {
          yield* reasoningDeltas.append({
            turnId: context.nativeTurnId,
            itemId,
            delta: event.delta.thinking,
          });
        }
      } else if (event.type === "content_block_stop") {
        const itemId = reasoning.streamBlocks.get(event.index);
        if (itemId !== undefined) {
          yield* reasoningDeltas.complete({
            turnId: context.nativeTurnId,
            itemId,
            emitEmpty: false,
          });
          reasoning.streamBlocks.delete(event.index);
        }
      }
      return true;
    }
    if (
      message.type === "assistant" &&
      !message.parent_tool_use_id &&
      !context.reasoning.snapshots.has(message.uuid)
    ) {
      context.reasoning.snapshots.add(message.uuid);
      // The SDK snapshots each completed block; count thinking blocks separately to preserve streamed ids.
      for (const block of message.message.content) {
        if (block.type !== "thinking") {
          const update = context.reasoning.lastThinking;
          context.reasoning.lastThinking = null;
          if (
            block.type === "tool_use" &&
            update !== null &&
            update.messageId === message.message.id &&
            update.followsThinking &&
            claudeWritesUpdatesAsThinking(message.message.model)
          ) {
            yield* emitAssistantTextArtifacts({
              context,
              nativeItemId: update.itemId,
              text: update.text,
            });
          }
          continue;
        }
        const index = context.reasoning.snapshotBlockIndex.get(message.message.id) ?? 0;
        context.reasoning.snapshotBlockIndex.set(message.message.id, index + 1);
        const itemId = `${message.message.id}:thinking:${index}`;
        yield* ensureReasoningBlock(context, itemId);
        const finalText = block.thinking || context.reasoning.blocks.get(itemId)?.text;
        const completedText = yield* reasoningDeltas.complete({
          turnId: context.nativeTurnId,
          itemId,
          ...(finalText ? { finalText } : {}),
          emitEmpty: false,
        });
        const previous = context.reasoning.lastThinking;
        context.reasoning.lastThinking = completedText.trim()
          ? {
              messageId: message.message.id,
              itemId,
              text: completedText,
              followsThinking: previous !== null && previous.messageId === message.message.id,
            }
          : null;
      }
    }

    if (message.type === "assistant" && frame.replayed !== true) {
      if (message.parent_tool_use_id === null) {
        // CLI notices and API errors arrive as assistant messages from "<synthetic>".
        if (message.message.model && message.message.model !== "<synthetic>") {
          context.rootModels.add(message.message.model);
        }
        // Subagent uuids exist only in the sidechain transcript, so resume and fork cannot target them.
        context.nativeMessageCursor = message.uuid;
        context.latestAssistantRateLimit =
          message.error === "rate_limit" ? { type: null, resetAt: null } : null;
        if (message.error === "rate_limit" && isClaudeBlockedAssistantRateLimit(message)) {
          const info = message.api_error_params.rate_limit_info;
          const overageAllowed =
            info.overageStatus === "allowed" ||
            info.overageStatus === "allowed_warning" ||
            info.isUsingOverage === true ||
            info.overageInUse === true;
          if (!overageAllowed) {
            context.latestAssistantRateLimit = {
              type: typeof info.rateLimitType === "string" ? info.rateLimitType : "unknown",
              resetAt: claudeUsageLimitResetAt(info.resetsAt),
            };
          }
        }
        if (message.error === "authentication_failed") {
          context.authenticationFailureMessage = claudeSignedOutMessage({
            configDir: adapterOptions.environment.CLAUDE_CONFIG_DIR,
            cwd: path.resolve(context.input.runtimePolicy.cwd ?? "."),
          });
        }
      }
    }

    if (
      message.type === "system" &&
      message.subtype === "status" &&
      (message.compact_result !== undefined ||
        (message.status === null && message.permissionMode === undefined))
    ) {
      if (message.compact_result !== undefined) {
        context.compactionFailure =
          message.compact_result === "failed" ? { message: message.compact_error } : null;
      }
      if (context.compaction?.status === "running") {
        const now = yield* DateTime.now;
        context.compaction = {
          ...context.compaction,
          status:
            message.compact_result === "success"
              ? "completed"
              : message.compact_result === "failed"
                ? "failed"
                : "interrupted",
          title:
            message.compact_result === "success"
              ? "Context compacted"
              : message.compact_result === "failed"
                ? "Context compaction failed"
                : "Context compaction stopped",
          ...(message.compact_result === "failed" && message.compact_error
            ? { summary: message.compact_error }
            : {}),
          completedAt: now,
          updatedAt: now,
        };
        yield* emitProviderEvent({
          type: "turn_item.updated",
          driver: CLAUDE_PROVIDER,
          turnItem: context.compaction,
        });
        if (message.compact_result !== "success") {
          context.compaction = null;
          const budget = pdfBudgets.get(context.nativeThreadId);
          if (budget !== undefined) budget.compacting = null;
        }
      }
    }

    if (
      message.type === "system" &&
      (message.subtype === "compact_boundary" ||
        (message.subtype === "status" && message.status === "compacting"))
    ) {
      if (message.subtype === "status" && context.compaction?.status === "running") return;
      const now = yield* DateTime.now;
      const nativeItemId = message.uuid;
      const compaction =
        (message.subtype === "compact_boundary" ? context.compaction : null) ??
        ({
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: CLAUDE_PROVIDER,
            nativeItemId,
          }),
          threadId: context.input.threadId,
          runId: context.input.runId,
          nodeId: context.input.rootNodeId,
          providerThreadId: context.input.providerThread.id,
          providerTurnId: context.providerTurnId,
          nativeItemRef: {
            driver: CLAUDE_PROVIDER,
            nativeId: nativeItemId,
            strength: "strong",
          },
          parentItemId: null,
          ordinal: yield* resolveItemOrdinal(context, nativeItemId),
          type: "compaction",
          driver: CLAUDE_PROVIDER,
          status: "running",
          title: "Compacting context",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        } satisfies OrchestrationV2TurnItem);
      if (message.subtype === "status") {
        const budget = pdfBudgets.get(context.nativeThreadId);
        // Offers made while compaction runs are outside the history it
        // removes. Pending reservations must survive its boundary too.
        if (budget !== undefined) budget.compacting = { ...budget.committed };
        context.compaction = compaction;
        yield* emitProviderEvent({
          type: "turn_item.updated",
          driver: CLAUDE_PROVIDER,
          turnItem: compaction,
        });
        return true;
      }
      const budget = pdfBudgets.get(context.nativeThreadId);
      if (budget !== undefined) {
        // Aggregate persisted usage cannot identify attachments in a
        // preserved segment. Retain it conservatively on partial compacts.
        if (
          message.compact_metadata.preserved_segment === undefined &&
          message.compact_metadata.preserved_messages === undefined
        ) {
          const compacted = budget.compacting ?? { ...budget.committed };
          budget.committed.pages -= compacted.pages;
          budget.committed.bytes -= compacted.bytes;
        }
        budget.compacting = null;
        yield* persistAttachmentBudget(context.nativeThreadId);
      }
      if (context.streamUsage !== null) context.streamUsage.usage = null;
      const postTokens = message.compact_metadata.post_tokens;
      const afterTokenCount =
        typeof postTokens === "number" && Number.isFinite(postTokens) && postTokens > 0
          ? Math.round(postTokens)
          : undefined;
      context.compactionTokens = afterTokenCount;
      if (afterTokenCount !== undefined) yield* emitContextUsage(context, afterTokenCount);
      yield* emitProviderEvent({
        type: "turn_item.updated",
        driver: CLAUDE_PROVIDER,
        turnItem: {
          ...compaction,
          status: "completed",
          title: "Context compacted",
          completedAt: compaction.completedAt ?? now,
          updatedAt: now,
          ...(message.compact_metadata.pre_tokens === undefined
            ? {}
            : { beforeTokenCount: message.compact_metadata.pre_tokens }),
          ...(afterTokenCount === undefined ? {} : { afterTokenCount }),
        },
      });
      context.compaction = null;
      return true;
    }

    if (
      message.type === "system" &&
      (message.subtype === "model_refusal_fallback" ||
        (message.subtype === "informational" && message.level !== "info"))
    ) {
      const now = yield* DateTime.now;
      const nativeItemId = message.uuid;
      context.assistant.noticeTexts.add(message.content);
      yield* emitProviderEvent({
        type: "turn_item.updated",
        driver: CLAUDE_PROVIDER,
        turnItem: {
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: CLAUDE_PROVIDER,
            nativeItemId,
          }),
          threadId: context.input.threadId,
          runId: context.input.runId,
          nodeId: context.input.rootNodeId,
          providerThreadId: context.input.providerThread.id,
          providerTurnId: context.providerTurnId,
          nativeItemRef: {
            driver: CLAUDE_PROVIDER,
            nativeId: nativeItemId,
            strength: "strong",
          },
          parentItemId: null,
          ordinal: yield* resolveItemOrdinal(context, nativeItemId),
          type: "system_notice",
          status: "completed",
          title: message.content,
          message: message.content,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });
      return true;
    }
    return false;
  });
  return {
    handleFramePartA,
  };
};
