import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { playbackComposerRequests, playbackTimeline, playSteps, type Step } from "./playback";
import { turnScripts } from "./turnScripts";

const command = (input: string) => ({ type: "command_execution" as const, input });

describe("turn playback", () => {
  it("drops command output the way the wire does, keeping the failure", () => {
    const steps: Step[] = [
      { kind: "turn", prompt: "Run the tests." },
      { kind: "start", key: "test", body: command("pnpm vitest run") },
      {
        kind: "finish",
        key: "test",
        status: "failed",
        patch: { exitCode: 1, output: " Tests  2 failed | 40 passed (42)" },
      },
    ];
    const { entries } = playbackTimeline(playSteps(steps));
    const work = entries.find((entry) => entry.kind === "work");
    expect(JSON.stringify(entries)).not.toContain("40 passed");
    expect(work?.kind === "work" && work.entry.structuredPayload).toMatchObject({
      outputIndicatesFailure: true,
      failedTestCount: 2,
    });
  });

  it("shows streaming text a paragraph at a time, then all of it on settle", () => {
    const answer = (text: string) => ({
      type: "assistant_message" as const,
      messageId: MessageId.make("answer"),
      text,
      streaming: true,
    });
    const steps: Step[] = [
      { kind: "turn", prompt: "Explain." },
      { kind: "start", key: "a", body: answer("First para") },
      { kind: "update", key: "a", patch: { text: "First paragraph.\n\nSecond para" } },
      { kind: "finish", key: "a", patch: { text: "First paragraph.\n\nSecond paragraph." } },
    ];
    const messageText = (count: number) =>
      playbackTimeline(playSteps(steps, count)).entries.flatMap((entry) =>
        entry.kind === "message" && entry.message.role === "assistant" ? [entry.message.text] : [],
      );
    expect(messageText(2)).toEqual([]);
    expect(messageText(3)).toEqual(["First paragraph.\n\n"]);
    expect(messageText(4)).toEqual(["First paragraph.\n\nSecond paragraph."]);
  });

  it("keeps a started item running until it finishes", () => {
    const steps: Step[] = [
      { kind: "turn", prompt: "Typecheck." },
      { kind: "start", key: "tc", body: command("pnpm typecheck") },
      { kind: "finish", key: "tc", patch: { exitCode: 0 } },
    ];
    expect(playSteps(steps, 2).items.at(-1)?.status).toBe("running");
    expect(playSteps(steps, 3).items.at(-1)).toMatchObject({ status: "completed", exitCode: 0 });
  });

  it("settles running items and records the interrupt when the user stops", () => {
    const state = playSteps([
      { kind: "turn", prompt: "Run everything." },
      { kind: "start", key: "suite", body: command("pnpm test") },
      { kind: "end", ending: "interrupted" },
    ]);
    expect(state.runs.at(-1)?.status).toBe("interrupted");
    expect(state.items.map((item) => [item.type, item.status])).toEqual([
      ["user_message", "completed"],
      ["command_execution", "interrupted"],
      ["run_interrupt_result", "completed"],
    ]);
  });

  it("surfaces an approval to the composer until it is answered", () => {
    const steps: Step[] = [
      { kind: "turn", prompt: "Clean up." },
      {
        kind: "request",
        key: "rm",
        request: { kind: "approval", requestKind: "command", prompt: "rm -rf dist" },
      },
      { kind: "resolve", key: "rm", decision: "accept" },
    ];
    const pending = playbackComposerRequests(playSteps(steps, 2));
    expect(pending.approvals).toMatchObject([
      { requestKind: "command", detail: "rm -rf dist", responseCapability: "live" },
    ]);
    const answered = playSteps(steps, 3);
    expect(playbackComposerRequests(answered).approvals).toEqual([]);
    expect(answered.items.at(-1)).toMatchObject({ type: "approval_request", status: "completed" });
  });

  it("keeps a question's answers on its item once answered", () => {
    const question = {
      id: "scope",
      header: "Scope",
      question: "Which files?",
      options: [{ label: "Web", description: "apps/web only" }],
    };
    const steps: Step[] = [
      { kind: "turn", prompt: "Refactor." },
      { kind: "request", key: "q", request: { kind: "question", questions: [question] } },
      { kind: "resolve", key: "q", answers: { scope: "Web" } },
    ];
    expect(playbackComposerRequests(playSteps(steps, 2)).userInputs).toHaveLength(1);
    const answered = playSteps(steps);
    expect(playbackComposerRequests(answered).userInputs).toEqual([]);
    expect(answered.items.at(-1)).toMatchObject({
      type: "user_input_request",
      questionAnswer: { answers: { scope: "Web" } },
    });
  });

  it("offers a proposed plan only once the turn settles", () => {
    const steps: Step[] = [
      { kind: "turn", prompt: "Plan it." },
      { kind: "plan", key: "plan", markdown: "# Tighten the footer\n\n1. Measure\n2. Fold" },
      { kind: "end", ending: "completed" },
    ];
    expect(playbackComposerRequests(playSteps(steps, 2)).proposedPlan).toBeNull();
    expect(playbackComposerRequests(playSteps(steps)).proposedPlan).toMatchObject({
      status: "active",
      planMarkdown: "# Tighten the footer\n\n1. Measure\n2. Fold",
    });
  });

  it("cancels a request the run stops waiting on", () => {
    const state = playSteps([
      { kind: "turn", prompt: "Delete it." },
      {
        kind: "request",
        key: "rm",
        request: { kind: "approval", requestKind: "command", prompt: "rm -rf dist" },
      },
      { kind: "end", ending: "interrupted" },
    ]);
    expect(state.runtimeRequests.map((request) => request.status)).toEqual(["cancelled"]);
    expect(playbackComposerRequests(state).approvals).toEqual([]);
  });

  it("joins a steer to the running run without starting a new one", () => {
    const state = playSteps([
      { kind: "turn", prompt: "Wrap the footer." },
      { kind: "steer", key: "s", text: "Use an overflow menu instead." },
      { kind: "steer", key: "q", text: "And update the tests.", promoted: true },
      { kind: "end", ending: "completed" },
      { kind: "steer", key: "late", text: "Too late." },
    ]);
    expect(state.runs).toHaveLength(1);
    const messages = state.items.filter((item) => item.type === "user_message");
    expect(messages.map((item) => [item.runId, item.inputIntent])).toEqual([
      [state.runs[0]!.runId, "turn_start"],
      [state.runs[0]!.runId, "steer"],
      [state.runs[0]!.runId, "promoted_queued_to_steer"],
    ]);
  });

  it("ignores tool steps once the turn has ended", () => {
    const ended = playSteps([
      { kind: "turn", prompt: "Hi." },
      { kind: "end", ending: "completed" },
    ]);
    const after = playSteps([
      { kind: "turn", prompt: "Hi." },
      { kind: "end", ending: "completed" },
      { kind: "start", key: "late", body: command("ls") },
    ]);
    expect(after.items).toEqual(ended.items);
  });

  it("plays every script to a settled turn with timeline rows at each step", () => {
    for (const script of turnScripts) {
      for (let count = 1; count <= script.steps.length; count += 1) {
        expect(
          playbackTimeline(playSteps(script.steps, count)).entries.length,
          script.id,
        ).toBeGreaterThan(0);
      }
      expect(playSteps(script.steps).runs.at(-1)?.status, script.id).not.toBe("running");
    }
  });
});
