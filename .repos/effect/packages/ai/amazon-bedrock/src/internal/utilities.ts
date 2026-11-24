import type * as Response from "effect/ai/Response"

const finishReasonMap: Record<string, Response.FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool-calls",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  guardrail_intervened: "content-filter",
  content_filtered: "content-filter",
  malformed_model_output: "error",
  malformed_tool_use: "error"
}

/** @internal */
export const resolveFinishReason = (
  stopReason: string,
  isJsonResponse: boolean = false
): Response.FinishReason => {
  const reason = Object.hasOwn(finishReasonMap, stopReason) ? finishReasonMap[stopReason] : "other"
  return isJsonResponse && reason === "tool-calls" ? "stop" : reason
}
