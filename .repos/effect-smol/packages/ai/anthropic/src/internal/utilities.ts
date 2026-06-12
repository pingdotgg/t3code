import * as Predicate from "effect/Predicate"
import type * as Response from "effect/unstable/ai/Response"

const finishReasonMap: Record<string, Response.FinishReason> = {
  end_turn: "stop",
  max_tokens: "length",
  pause_turn: "pause",
  refusal: "content-filter",
  stop_sequence: "stop",
  tool_use: "tool-calls"
}

/** @internal */
export const resolveFinishReason = (
  finishReason: string,
  isJsonResponse: boolean = false
): Response.FinishReason => {
  const reason = finishReasonMap[finishReason]
  if (Predicate.isUndefined(reason)) {
    return "unknown"
  }
  if (isJsonResponse && reason === "tool-calls") {
    return "stop"
  }
  return reason
}
