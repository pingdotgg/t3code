import { useEffect, useRef } from "react";
import type { ThreadId } from "@t3tools/contracts";
import { useStore } from "../store";
import { useTokenUsageStore } from "../tokenUsageStore";

/**
 * Watches thread activities for token usage events and feeds them
 * into the token usage store. Should be mounted once at the root level.
 */
export function useTokenUsageSync() {
  const threads = useStore((s) => s.threads);
  const processedIds = useRef(new Set<string>());

  useEffect(() => {
    const {
      recordTurnUsage,
      updateThreadTokenUsage,
      updateRateLimits,
      updateAccountInfo,
    } = useTokenUsageStore.getState();

    for (const thread of threads) {
      for (const activity of thread.activities) {
        if (processedIds.current.has(activity.id)) continue;
        processedIds.current.add(activity.id);

        const payload = activity.payload as Record<string, unknown> | null;
        if (!payload) continue;

        switch (activity.kind) {
          case "turn.usage": {
            const promptTokens =
              (payload.prompt_tokens as number) ??
              (payload.promptTokens as number) ??
              (payload.input_tokens as number) ??
              0;
            const completionTokens =
              (payload.completion_tokens as number) ??
              (payload.completionTokens as number) ??
              (payload.output_tokens as number) ??
              0;
            const totalTokens =
              (payload.total_tokens as number) ??
              (payload.totalTokens as number) ??
              promptTokens + completionTokens;
            const costUsd = (payload.totalCostUsd as number) ?? null;

            if (totalTokens > 0 || costUsd !== null) {
              recordTurnUsage(thread.id as ThreadId, {
                promptTokens,
                completionTokens,
                totalTokens,
                costUsd,
                model: null,
              });
            }
            break;
          }

          case "thread.token-usage": {
            updateThreadTokenUsage(thread.id as ThreadId, payload);
            break;
          }

          case "account.rate-limits": {
            updateRateLimits("codex", payload);
            break;
          }

          case "account.updated": {
            updateAccountInfo(payload);
            break;
          }
        }
      }
    }
  }, [threads]);
}
