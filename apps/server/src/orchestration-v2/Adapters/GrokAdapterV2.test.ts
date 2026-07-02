import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  AcpProviderCapabilitiesV2,
  acpPermissionDisposition,
  acpRootSessionUpdateIngestsOutput,
  acpRootTurnCompletionDrainMs,
  acpRootTurnHasIngestedOutput,
  acpRootTurnIsIdle,
  acpRootTurnSettleDebounceMs,
  acpRootTurnShouldRearmRecoveryTimers,
} from "./AcpAdapterV2.ts";
import { GrokProviderCapabilitiesV2 } from "./GrokAdapterV2.ts";

function permissionRequest(
  kind: EffectAcpSchema.ToolKind,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    toolCall: {
      toolCallId: "tool-1",
      title: "Test tool",
      kind,
    },
  };
}

function runtimePolicy(input: {
  readonly runtimeMode: "approval-required" | "auto-accept-edits" | "full-access";
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}) {
  return ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
    ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: input.sandboxPolicy }),
  });
}

describe("acpRootTurnSettleDebounceMs", () => {
  it("allows tool calls to land after a brief assistant preamble", () => {
    assert.equal(acpRootTurnSettleDebounceMs, 2_000);
  });
});

describe("acpRootTurnCompletionDrainMs", () => {
  it("gives trailing root chunks a short landing window", () => {
    assert.equal(acpRootTurnCompletionDrainMs, 100);
  });
});

describe("acpRootSessionUpdateIngestsOutput", () => {
  const sessionId = "session-1";

  it("ignores empty assistant chunks used as Grok keepalives", () => {
    assert.isFalse(
      acpRootSessionUpdateIngestsOutput({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "" },
        },
      }),
    );
  });

  it("accepts non-empty assistant and reasoning chunks", () => {
    assert.isTrue(
      acpRootSessionUpdateIngestsOutput({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      }),
    );
    assert.isTrue(
      acpRootSessionUpdateIngestsOutput({
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        },
      }),
    );
  });

  it("accepts tool and plan updates", () => {
    assert.isTrue(
      acpRootSessionUpdateIngestsOutput({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read",
          kind: "read",
          status: "pending",
        },
      }),
    );
    assert.isTrue(
      acpRootSessionUpdateIngestsOutput({
        sessionId,
        update: {
          sessionUpdate: "plan",
          entries: [{ content: "Step 1", status: "pending", priority: "medium" }],
        },
      }),
    );
  });
});

describe("acpRootTurnHasIngestedOutput", () => {
  const empty = {
    assistant: { current: null, nextSegment: 0 },
    reasoning: { current: null, nextSegment: 0 },
    tools: new Map(),
    plan: null,
  } as const;

  it("is false before any root turn items land", () => {
    assert.isFalse(acpRootTurnHasIngestedOutput(empty));
  });

  it("is true once assistant segments have streamed", () => {
    assert.isTrue(
      acpRootTurnHasIngestedOutput({
        ...empty,
        assistant: { current: null, nextSegment: 1 },
      }),
    );
  });
});

describe("acpRootTurn recovery timer re-arm", () => {
  it("re-arms idle settle after pending clears on active turns", () => {
    assert.isTrue(acpRootTurnShouldRearmRecoveryTimers({ finalized: false, interrupted: false }));
  });

  it("skips re-arm when the turn is already terminal", () => {
    assert.isFalse(acpRootTurnShouldRearmRecoveryTimers({ finalized: true, interrupted: false }));
    assert.isFalse(acpRootTurnShouldRearmRecoveryTimers({ finalized: false, interrupted: true }));
  });
});

describe("acpRootTurnIsIdle", () => {
  const idle = {
    finalized: false,
    interrupted: false,
    assistantStreamOpen: false,
    reasoningStreamOpen: false,
    hasRunningTool: false,
    hasPendingRuntimeRequest: false,
    hasToolHistory: false,
    hasRunningSubagent: false,
    hasOutput: true,
  } as const;

  it("is false while assistant text is still streaming", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...idle, assistantStreamOpen: true }));
  });

  it("is false while a tool is running", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...idle, hasRunningTool: true }));
  });

  it("is false after tool history until the prompt RPC completes", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...idle, hasToolHistory: true }));
  });

  it("is false while a native subagent task is still running", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...idle, hasRunningSubagent: true }));
  });

  it("is false when only reasoning or tools have streamed", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...idle, hasOutput: false }));
  });

  it("is true when root assistant output is quiescent", () => {
    assert.isTrue(acpRootTurnIsIdle(idle));
  });
});

describe("GrokAdapterV2 capabilities", () => {
  it("keeps optional protocol features conservative until a flavor or handshake confirms them", () => {
    assert.isFalse(AcpProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    assert.isFalse(AcpProviderCapabilitiesV2.sessions.supportsRuntimeModeSwitchInSession);
    assert.isFalse(AcpProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isFalse(AcpProviderCapabilitiesV2.tools.supportsMcpTools);
  });

  it("declares Grok Task envelopes as native subagents", () => {
    assert.isFalse(GrokProviderCapabilitiesV2.threads.canForkThread);
    assert.isTrue(GrokProviderCapabilitiesV2.subagents.supportsSubagents);
    assert.isTrue(GrokProviderCapabilitiesV2.subagents.exposesSubagentThreadIds);
    assert.isTrue(GrokProviderCapabilitiesV2.subagents.emitsSubagentLifecycle);
    assert.isFalse(GrokProviderCapabilitiesV2.turns.supportsActiveSteering);
    assert.isTrue(GrokProviderCapabilitiesV2.turns.supportsInterrupt);
    assert.isTrue(GrokProviderCapabilitiesV2.turns.supportsSteeringByInterruptRestart);
    assert.isTrue(GrokProviderCapabilitiesV2.context.supportsFullThreadHandoff);
  });

  it("declares the optional ACP features verified by the Grok handshake", () => {
    assert.isTrue(GrokProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    assert.isTrue(GrokProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isTrue(GrokProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.isTrue(GrokProviderCapabilitiesV2.checkpointing.providerCanReadConversationSnapshot);
  });
});

describe("ACP permission policy", () => {
  it("honors explicit on-request approval over full-access runtime mode", () => {
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({
          runtimeMode: "full-access",
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "readOnly" },
        }),
        permissionRequest("execute"),
      ),
      "ask",
    );
  });

  it("rejects mutating escalation under a non-interactive read-only policy", () => {
    const policy = runtimePolicy({
      runtimeMode: "full-access",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });
    assert.equal(acpPermissionDisposition(policy, permissionRequest("execute")), "deny");
    assert.equal(acpPermissionDisposition(policy, permissionRequest("edit")), "deny");
    assert.equal(acpPermissionDisposition(policy, permissionRequest("read")), "allow");
  });

  it("auto-approves requests only when the resolved policy permits them", () => {
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({
          runtimeMode: "full-access",
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        }),
        permissionRequest("execute"),
      ),
      "allow",
    );
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({ runtimeMode: "approval-required" }),
        permissionRequest("read"),
      ),
      "ask",
    );
  });
});
