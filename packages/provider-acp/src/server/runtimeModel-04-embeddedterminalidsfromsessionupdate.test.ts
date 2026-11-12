import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/compat";

import {
  decideToolCallUpdateEmission,
  applyAcpAgentTerminalUpdate,
  acpContentBlockDisplayText,
  embeddedTerminalIdsFromSessionUpdate,
  extractMcpToolCallIdentity,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionModelStateFromInitialize,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  syntheticLoadSessionResponseFromInitialize,
  toolCallProgressLength,
  withTrackedPermissionToolCall,
  type AcpToolCallState,
} from "./runtimeModel.ts";





describe("embeddedTerminalIdsFromSessionUpdate", () => {
  it("collects terminal ids from tool_call content before the text rewrite", () => {
    expect(
      embeddedTerminalIdsFromSessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_1",
          status: "in_progress",
          content: [
            { type: "terminal", terminalId: "t3-term-9" },
            { type: "content", content: { type: "text", text: "noise" } },
          ],
        },
      }),
    ).toEqual({ toolCallId: "call_1", terminalIds: ["t3-term-9"] });
    expect(
      embeddedTerminalIdsFromSessionUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_2",
          title: "Tool",
          status: "pending",
        },
      }),
    ).toBeUndefined();
  });
});

