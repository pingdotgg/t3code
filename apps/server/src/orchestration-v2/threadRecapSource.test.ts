import {
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveThreadRecapSource, type ThreadRecapSourceInput } from "./threadRecapSource.ts";

const threadId = ThreadId.make("thread-1");
const now = DateTime.makeUnsafe("2026-11-28T12:00:00.000Z");
const msg = (
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  extra?: Partial<OrchestrationV2ConversationMessage>,
) =>
  ({
    id: MessageId.make(id),
    role,
    text,
    attachments: [],
    streaming: false,
    updatedAt: now,
    ...extra,
  }) as unknown as OrchestrationV2ConversationMessage;
const run = (ordinal: number, status: OrchestrationV2Run["status"]) =>
  ({ id: RunId.make(`run-${ordinal}`), ordinal, status }) as unknown as OrchestrationV2Run;
const derive = (overrides: Partial<ThreadRecapSourceInput>) =>
  deriveThreadRecapSource({
    thread: { id: threadId, title: "Auth" },
    messages: [],
    runs: [run(1, "completed")],
    runtimeRequests: [],
    plans: [],
    checkpoints: [],
    previousCoveredMessageId: null,
    hasPreviousRecap: false,
    ...overrides,
  });

describe("deriveThreadRecapSource", () => {
  it("reports unsettled while a run is active or a message is streaming", () => {
    expect(
      derive({ messages: [msg("m1", "user", "Fix")], runs: [run(1, "running")] }).isSettled,
    ).toBe(false);
    expect(
      derive({ messages: [msg("m1", "assistant", "Working", { streaming: true })] }).isSettled,
    ).toBe(false);
    expect(
      derive({ messages: [msg("m1", "user", "Fix")], runs: [run(1, "queued")] }).isSettled,
    ).toBe(true);
  });

  it("selects only new delta messages after coveredMessageId and ignores system/workflow scripts", () => {
    const messages = [
      msg("m1", "user", "First question"),
      msg("m2", "assistant", "First answer"),
      msg("m3", "system", "System noise"),
      msg("m4", "user", "Workflow script", { workflowScript: true }),
      msg("m5", "user", "Second question"),
      msg("m6", "assistant", "Second answer"),
    ];
    expect(
      derive({ messages, previousCoveredMessageId: MessageId.make("m6"), hasPreviousRecap: true })
        .hasNewMaterial,
    ).toBe(false);

    const delta = derive({
      messages,
      runs: [run(2, "completed")],
      previousCoveredMessageId: MessageId.make("m2"),
      hasPreviousRecap: true,
    });
    expect(delta).toMatchObject({
      isSettled: true,
      hasNewMaterial: true,
      latestMessageId: MessageId.make("m6"),
    });
    expect(delta.newMaterial).toContain("Second question");
    expect(delta.newMaterial).toContain("Second answer");
    expect(delta.newMaterial).not.toContain("First question");
    expect(delta.newMaterial).not.toContain("System noise");
    expect(delta.newMaterial).not.toContain("Workflow script");
  });

  it("includes pending requests, active proposed plans, and latest changed files in state and signature", () => {
    const source = derive({
      messages: [msg("m1", "user", "Check auth")],
      runtimeRequests: [{ kind: "command", status: "pending" } as OrchestrationV2RuntimeRequest],
      plans: [{ kind: "proposed_plan", status: "active" } as OrchestrationV2PlanArtifact],
      checkpoints: [
        { files: [{ path: "apps/server/src/ws.ts" }] } as unknown as OrchestrationV2Checkpoint,
      ],
    });
    expect(source.currentState).toContain("Latest turn: completed");
    expect(source.currentState).toContain("Pending: approval required");
    expect(source.currentState).toContain("Pending: proposed plan awaiting decision");
    expect(source.currentState).toContain("apps/server/src/ws.ts");
    expect(source.signature).toContain("|approval||plan");
  });
});
