import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  buildProviderHandoff,
  resolveHandoffBudgetChars,
  withProviderHandoff,
} from "./providerHandoff.ts";

const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  minute: number,
  turnId: string | null = null,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: turnId === null ? null : TurnId.make(turnId),
  streaming: false,
  createdAt: at(minute),
  updatedAt: at(minute),
});

const toolCompleted = (
  id: string,
  turnId: string,
  detail: string,
  minute: number,
  status = "completed",
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "tool",
  kind: "tool.completed",
  summary: "Command run",
  payload: { itemType: "command_execution", status, title: "Command run", detail },
  turnId: TurnId.make(turnId),
  createdAt: at(minute),
});

const base = {
  fromLabel: "Claude Opus 4.6",
  toLabel: "GPT-5.4",
  activities: [] as OrchestrationThreadActivity[],
  proposedPlans: [] as OrchestrationProposedPlan[],
  currentMessageId: MessageId.make("current"),
  currentMessageChars: 20,
};

describe("buildProviderHandoff", () => {
  it("renders messages and a tool trail in order, excluding the turn being sent", () => {
    const handoff = buildProviderHandoff({
      ...base,
      messages: [
        message("m1", "user", "Fix the flaky test", 1),
        message("m1r", "reasoning", "thinking out loud", 2, "t1"),
        message("m2", "assistant", "Fixed it by awaiting the receipt.", 4, "t1"),
        message("current", "user", "Now open a PR", 5),
      ],
      activities: [
        toolCompleted("a1", "t1", "Bash: vp test run foo.test.ts", 3),
        toolCompleted("a2", "t1", "Bash: vp test run bar.test.ts", 3, "failed"),
      ],
    });

    expect(handoff.includedMessages).toBe(2);
    expect(handoff.omittedMessages).toBe(0);
    expect(handoff.toolCalls).toBe(2);
    expect(handoff.text).toContain("started with Claude Opus 4.6 and continues with you (GPT-5.4)");
    expect(handoff.text).not.toContain("thinking out loud");
    expect(handoff.text).not.toContain("Now open a PR");
    const user = handoff.text.indexOf("### User\nFix the flaky test");
    const tools = handoff.text.indexOf("Tool calls (2):");
    const assistant = handoff.text.indexOf("### Assistant\nFixed it");
    expect(user).toBeGreaterThan(-1);
    expect(tools).toBeGreaterThan(user);
    expect(assistant).toBeGreaterThan(tools);
    expect(handoff.text).toContain("- Bash: vp test run bar.test.ts (failed)");
  });

  it("includes the latest unimplemented plan", () => {
    const plan = (id: string, markdown: string, minute: number, implemented: boolean) => ({
      id,
      turnId: null,
      planMarkdown: markdown,
      implementedAt: implemented ? at(minute) : null,
      implementationThreadId: null,
      createdAt: at(minute),
      updatedAt: at(minute),
    });
    const handoff = buildProviderHandoff({
      ...base,
      messages: [message("m1", "user", "Plan it", 1)],
      proposedPlans: [
        plan("p1", "1. old plan", 1, false),
        plan("p2", "1. shipped plan", 3, true),
        plan("p3", "1. current plan", 2, false),
      ],
    });
    expect(handoff.text).toContain("## Current plan\n1. current plan");
    expect(handoff.text).not.toContain("old plan");
    expect(handoff.text).not.toContain("shipped plan");
  });

  it("keeps the newest history and the opening request when the budget is tight", () => {
    const filler = "x".repeat(9_000);
    const messages = [message("m0", "user", "Original task statement", 0)];
    for (let index = 1; index <= 40; index += 1) {
      messages.push(
        message(`m${index}`, index % 2 === 0 ? "user" : "assistant", `${index} ${filler}`, index),
      );
    }
    const handoff = buildProviderHandoff({ ...base, messages });

    expect(handoff.text.length).toBeLessThanOrEqual(
      resolveHandoffBudgetChars({ currentMessageChars: base.currentMessageChars }),
    );
    expect(handoff.omittedMessages).toBeGreaterThan(0);
    expect(handoff.includedMessages + handoff.omittedMessages).toBe(41);
    expect(handoff.text).toContain("### User\nOriginal task statement");
    expect(handoff.text).toContain(`### User\n40 ${filler}`);
    expect(handoff.text).toContain(`[${handoff.omittedMessages} earlier messages omitted`);
    expect(handoff.text).not.toContain(`### Assistant\n1 ${filler}`);
  });

  it("sizes the budget to the target context window and the turn input limit", () => {
    expect(resolveHandoffBudgetChars({ contextWindowTokens: 32_000, currentMessageChars: 0 })).toBe(
      28_000,
    );
    expect(
      resolveHandoffBudgetChars({ contextWindowTokens: 1_000_000, currentMessageChars: 10_000 }),
    ).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 10_000);
  });

  it("fits under the provider input limit with the user's message", () => {
    const text = "y".repeat(50_000);
    const handoff = buildProviderHandoff({
      ...base,
      currentMessageChars: text.length,
      messages: Array.from({ length: 30 }, (_, index) =>
        message(`m${index}`, "assistant", "z".repeat(11_000), index),
      ),
    });
    expect(withProviderHandoff(handoff, text).length).toBeLessThanOrEqual(
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    );
  });
});
