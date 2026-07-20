import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  AcpProviderCapabilitiesV2,
  acpCompletedTurnShouldTerminalizeTool,
  acpPermissionDisposition,
  acpRootSessionUpdateIngestsOutput,
  acpRootTurnCompletionDrainMs,
  acpRootTurnHasIngestedOutput,
  acpRootTurnIsIdle,
  acpRootTurnSettleDebounceMs,
  acpRootTurnShouldRearmRecoveryTimers,
  acpSupportsImagePrompts,
} from "./AcpAdapterV2.ts";
import {
  makeGrokAcpAdapterFlavor,
  GrokProviderCapabilitiesV2,
  type GrokAdapterV2Options,
} from "./GrokAdapterV2.ts";

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
  it("keeps the historical debounce constant for re-enable experiments", () => {
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
  const quiet = {
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
    assert.isFalse(acpRootTurnIsIdle({ ...quiet, assistantStreamOpen: true }));
  });

  it("is false while a tool is running", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...quiet, hasRunningTool: true }));
  });

  it("is false after tool history (prompt RPC owns terminalization)", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...quiet, hasToolHistory: true }));
  });

  it("is false while a native subagent task is still running", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...quiet, hasRunningSubagent: true }));
  });

  it("is false when only reasoning or tools have streamed", () => {
    assert.isFalse(acpRootTurnIsIdle({ ...quiet, hasOutput: false }));
  });

  it("is false for assistant-only quiet (preamble-before-tools must not settle)", () => {
    assert.isFalse(acpRootTurnIsIdle(quiet));
  });

  it("is false when tools finished and root is quiet (no speculative multi-wave settle)", () => {
    assert.isFalse(
      acpRootTurnIsIdle({
        ...quiet,
        hasToolHistory: true,
        hasRunningTool: false,
      }),
    );
  });
});

describe("GrokAdapterV2 capabilities", () => {
  it("wires hard Stop teardown but soft non-Stop interrupts in the constructor flavor", () => {
    const flavor = makeGrokAcpAdapterFlavor({
      makeRuntime: () => Effect.never,
    } as unknown as GrokAdapterV2Options);

    assert.isFalse(flavor.interruptPromptOnCancel);
    // User Stop (requestRuntimeRestart) keeps the hard process-group kill and
    // respawn: Grok cancel is detach-and-continue, so only a process kill
    // stops the work.
    assert.isTrue(flavor.restartRuntimeAfterInterrupt);
    assert.isTrue(flavor.terminateRuntimeProcessGroupOnInterrupt);
    // Non-Stop interrupts (steering, restart_active) reuse the process and
    // session; the cancelled work backgrounds and the model decides its fate.
    assert.isUndefined(flavor.restartRuntimeOnEveryInterrupt);
    assert.isTrue(flavor.preserveRuntimeOnSettledInterrupt);
  });

  it("terminalizes only foreground tools under the actual Grok flavor", () => {
    const flavor = makeGrokAcpAdapterFlavor({
      makeRuntime: () => Effect.never,
    } as unknown as GrokAdapterV2Options);
    const foreground = {
      toolCallId: "foreground-1",
      title: "Terminal",
      status: "inProgress" as const,
      data: {
        rawInput: { command: "true" },
        rawOutput: { type: "Bash", exit_code: 0 },
      },
    };
    const monitor = {
      toolCallId: "monitor-1",
      title: "Monitor",
      status: "inProgress" as const,
      data: {
        rawInput: { variant: "Monitor", command: "sleep 30" },
        rawOutput: {
          type: "Monitor",
          taskId: "019f44b8-8e98-7c80-a40e-df1e26a5f9e3",
        },
      },
    };
    const subagent = {
      toolCallId: "subagent-1",
      title: "Task",
      status: "inProgress" as const,
      data: {
        rawInput: {
          description: "Inspect interrupt handling",
          prompt: "Review the adapter.",
          subagent_type: "generalPurpose",
        },
      },
    };

    assert.isTrue(acpCompletedTurnShouldTerminalizeTool(foreground, flavor));
    assert.isFalse(acpCompletedTurnShouldTerminalizeTool(monitor, flavor));
    assert.isFalse(acpCompletedTurnShouldTerminalizeTool(subagent, flavor));
  });

  it("keeps optional protocol features conservative until a flavor or handshake confirms them", () => {
    assert.isFalse(AcpProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    assert.isFalse(AcpProviderCapabilitiesV2.sessions.supportsRuntimeModeSwitchInSession);
    assert.isFalse(AcpProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isFalse(AcpProviderCapabilitiesV2.tools.supportsMcpTools);
  });

  it("overrides ACP image capability false so screenshot attachments can prompt", () => {
    // Handshake alone would refuse attachments (Grok advertises image:false).
    assert.isFalse(
      acpSupportsImagePrompts({
        negotiatedImage: false,
      }),
    );
    // Flavor override unblocks image content blocks for Grok.
    assert.isTrue(
      acpSupportsImagePrompts({
        flavorSupportsImagePrompts: true,
        negotiatedImage: false,
      }),
    );
    assert.isTrue(
      acpSupportsImagePrompts({
        negotiatedImage: true,
      }),
    );
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
