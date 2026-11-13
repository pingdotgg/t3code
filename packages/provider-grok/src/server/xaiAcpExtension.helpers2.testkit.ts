// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";
import {
  XAiExitPlanModeRequest,
  XAI_EMPTY_PLAN_MARKDOWN,
  isGrokPlanMarkdownPath,
  extractXAiExitPlanMarkdown,
  extractGrokPlanMarkdownFromToolCallData,
  extractXAiAcpBackgroundToolMutation,
  extractXAiAcpSubagentEndNotice,
  extractXAiAcpSubagentUpdate,
  extractXAiAskUserQuestions,
  extractXAiBackgroundTaskCompletion,
  extractXAiKilledBackgroundTasks,
  extractXAiMonitorTaskId,
  isXAiMonitorTool,
  makeXAiAskUserQuestionResponse,
  makeXAiPromptCompletionRuntime,
  normalizeXAiAcpToolCallState,
  xAiBackgroundTaskLifecycleMutation,
  xAiPromptCompleteFromSessionUpdate,
  xAiSubagentFinishedNotice,
  XAiAskUserQuestionRequest,
} from "./xaiAcpExtension.ts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  type AcpToolCallState,
  mergeToolCallState,
  parseSessionUpdateEvent,
} from "@t3tools/provider-acp/server/runtimeModel";

export const decodeXAiAskUserQuestionRequest = Schema.decodeUnknownSync(XAiAskUserQuestionRequest);

export function parseRecordedToolCallUpdate(update: Record<string, unknown>): AcpToolCallState {
  const [event] = parseSessionUpdateEvent({
    sessionId: "01a0d660-c1bb-7842-91a3-02d91dc8b0d2",
    update,
  } as Parameters<typeof parseSessionUpdateEvent>[0]).events;
  if (event?._tag !== "ToolCallUpdated") throw new Error("expected a tool call update");
  return event.toolCall;
}
