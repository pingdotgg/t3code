import { MessageId, ThreadId, type ChildNudgeUpdate } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { childNudgePrompt } from "./childNudging.ts";

describe("child nudge prompt", () => {
  it("fits a maximal multibyte decision while preserving its exact choices", () => {
    const options = Array.from({ length: 8 }, (_, index) => `${index}:${"界".repeat(498)}`);
    const update: ChildNudgeUpdate = {
      id: "report-a",
      childThreadId: ThreadId.make("child-a"),
      childTitle: "Child A",
      assignmentId: MessageId.make("assignment-a"),
      kind: "decision-needed",
      wakeReason: "decision-required",
      summary: "界".repeat(4_000),
      decision: {
        question: "界".repeat(2_000),
        options,
        recommendation: "界".repeat(1_000),
      },
    };

    const prompt = childNudgePrompt([update]);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(24 * 1024);
    for (const option of options) expect(prompt).toContain(option);
    expect(prompt).toContain(update.decision!.question);
    expect(prompt).toContain(update.decision!.recommendation);
  });

  it("keeps the prompt byte cap when wait progress is also present", () => {
    const update: ChildNudgeUpdate = {
      id: "report-a",
      childThreadId: ThreadId.make("child-a"),
      childTitle: "Child A",
      assignmentId: MessageId.make("assignment-a"),
      kind: "blocked",
      summary: "界".repeat(4_000),
    };

    const prompt = childNudgePrompt([update], `Wait: ${"界".repeat(8_000)}`);

    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(24 * 1024);
    expect(prompt).toContain("Wait:");
  });
});
