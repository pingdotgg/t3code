import type * as Response from "effect/unstable/ai/Response"

/** @internal */
export const ProviderOptionsKey = "@effect/ai-openai/OpenAiLanguageModel/ProviderOptions"

/** @internal */
export const ProviderMetadataKey = "@effect/ai-openai/OpenAiLanguageModel/ProviderMetadata"

const finishReasonMap: Record<string, Response.FinishReason> = {
  content_filter: "content-filter",
  function_call: "tool-calls",
  length: "length",
  stop: "stop",
  tool_calls: "tool-calls"
}

/** @internal */
export const escapeJSONDelta = (delta: string): string => JSON.stringify(delta).slice(1, -1)

/** @internal */
export const resolveFinishReason = (
  finishReason: string | null | undefined,
  hasToolCalls: boolean
): Response.FinishReason => {
  if (finishReason == null) {
    return hasToolCalls ? "tool-calls" : "stop"
  }
  const reason = finishReasonMap[finishReason]
  if (reason == null) {
    return hasToolCalls ? "tool-calls" : "unknown"
  }
  return reason
}
