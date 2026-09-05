import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  codexFeedbackMessage,
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "./threadFeedback.ts";

describe("parseCodexFeedbackCommand", () => {
  it("accepts feedback without a reason", () => {
    expect(parseCodexFeedbackCommand(" /feedback ")).toEqual({});
  });

  it("preserves a feedback description", () => {
    expect(parseCodexFeedbackCommand("/feedback The agent stopped early.")).toEqual({
      reason: "The agent stopped early.",
    });
  });

  it("accepts mixed-case feedback commands", () => {
    expect(parseCodexFeedbackCommand("/Feedback Retry failed.")).toEqual({
      reason: "Retry failed.",
    });
  });

  it("ignores other slash commands and ordinary messages", () => {
    expect(parseCodexFeedbackCommand("/feedback-status")).toBeNull();
    expect(parseCodexFeedbackCommand("Please send /feedback")).toBeNull();
  });
});

describe("submitCodexFeedback", () => {
  const submission = {
    id: MessageId.make("feedback-message-1"),
    command: "/feedback The agent stopped early.",
    createdAt: "2026-08-23T00:00:00.000Z",
  } as const;

  it("shows the command and clears the draft before the upload finishes", async () => {
    let draft: string = submission.command;
    let finishUpload:
      | ((result: ReturnType<typeof AsyncResult.success<{ feedbackId: string }>>) => void)
      | undefined;
    const states: CodexFeedbackSubmission[] = [];
    const upload = new Promise<ReturnType<typeof AsyncResult.success<{ feedbackId: string }>>>(
      (resolve) => {
        finishUpload = resolve;
      },
    );

    const result = submitCodexFeedback({
      submission,
      clearDraft: () => {
        draft = "";
      },
      onUpdate: (state) => states.push(state),
      upload: () => {
        expect(draft).toBe("");
        return upload;
      },
    });

    expect(draft).toBe("");
    expect(states).toEqual([{ ...submission, status: "uploading" }]);
    expect(codexFeedbackMessage(states[0]!)).toMatchObject({
      id: submission.id,
      role: "user",
      text: submission.command,
    });
    expect(codexFeedbackMessage(states[0]!, "assistant").text).toBe(
      "Sending feedback to OpenAI...",
    );

    draft = "Keep this newer message.";
    finishUpload?.(AsyncResult.success({ feedbackId: "codex-thread-1" }));
    await result;

    expect(draft).toBe("Keep this newer message.");
    expect(states.at(-1)).toEqual({
      ...submission,
      status: "sent",
      feedbackId: "codex-thread-1",
    });
    expect(codexFeedbackMessage(states.at(-1)!, "assistant").text).toContain("codex-thread-1");
  });

  it("records a failed upload without losing its user-facing error", async () => {
    const states: CodexFeedbackSubmission[] = [];
    const error = new Error("Upload rejected.");

    await submitCodexFeedback({
      submission,
      clearDraft: () => undefined,
      onUpdate: (state) => states.push(state),
      upload: () =>
        Promise.resolve(AsyncResult.failure<{ feedbackId: string }, Error>(Cause.fail(error))),
    });

    expect(states.at(-1)).toEqual({
      ...submission,
      status: "failed",
      errorMessage: "Upload rejected.",
    });
  });

  it("marks interruptions without reporting them as upload failures", async () => {
    const states: CodexFeedbackSubmission[] = [];

    await submitCodexFeedback({
      submission,
      clearDraft: () => undefined,
      onUpdate: (state) => states.push(state),
      upload: () =>
        Promise.resolve(AsyncResult.failure<{ feedbackId: string }, never>(Cause.interrupt(1))),
    });

    expect(states.at(-1)).toEqual({ ...submission, status: "interrupted" });
  });

  it("lets another feedback submission finish while the first remains in flight", async () => {
    let finishFirstUpload:
      | ((result: ReturnType<typeof AsyncResult.success<{ feedbackId: string }>>) => void)
      | undefined;
    const firstUpload = new Promise<ReturnType<typeof AsyncResult.success<{ feedbackId: string }>>>(
      (resolve) => {
        finishFirstUpload = resolve;
      },
    );
    const firstStates: CodexFeedbackSubmission[] = [];
    const secondStates: CodexFeedbackSubmission[] = [];

    const first = submitCodexFeedback({
      submission,
      clearDraft: () => undefined,
      onUpdate: (state) => firstStates.push(state),
      upload: () => firstUpload,
    });
    const second = await submitCodexFeedback({
      submission: {
        ...submission,
        id: MessageId.make("feedback-message-2"),
      },
      clearDraft: () => undefined,
      onUpdate: (state) => secondStates.push(state),
      upload: () => Promise.resolve(AsyncResult.success({ feedbackId: "codex-thread-2" })),
    });

    expect(firstStates.at(-1)?.status).toBe("uploading");
    expect(second._tag).toBe("Success");
    expect(secondStates.at(-1)).toMatchObject({
      status: "sent",
      feedbackId: "codex-thread-2",
    });

    finishFirstUpload?.(AsyncResult.success({ feedbackId: "codex-thread-1" }));
    await first;
  });
});
