import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { submitComposerDraft } from "./composerSubmission";

describe("submitComposerDraft", () => {
  it("keeps an oversized draft editable and sends a corrected follow-up", () => {
    let draft = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1);
    let validationMessage: string | null = null;
    const dispatchedDrafts: string[] = [];
    const preventDefault = vi.fn();

    const submit = () => {
      const result = submitComposerDraft({
        prompt: draft,
        submissionTarget: "provider-turn",
        event: { preventDefault },
        onSend: () => {
          dispatchedDrafts.push(draft);
        },
      });
      validationMessage = result.validationMessage;
    };

    submit();

    expect(dispatchedDrafts).toEqual([]);
    expect(draft).toHaveLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1);
    expect(validationMessage).toBe(
      "Prompt is 1 character over the 120,000-character limit. Shorten or split it before sending.",
    );
    expect(preventDefault).toHaveBeenCalledOnce();

    draft = "Corrected prompt";
    submit();

    expect(dispatchedDrafts).toEqual(["Corrected prompt"]);
    expect(validationMessage).toBeNull();
  });

  it("allows a draft at the shared character limit through the normal send path", () => {
    const draft = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    const onSend = vi.fn();
    const preventDefault = vi.fn();

    const result = submitComposerDraft({
      prompt: draft,
      submissionTarget: "provider-turn",
      event: { preventDefault },
      onSend,
    });

    expect(result).toEqual({ validationMessage: null, didDispatch: true });
    expect(onSend).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("blocks when appended context pushes the provider input over the shared limit", () => {
    const draft = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    const onSend = vi.fn();

    const result = submitComposerDraft({
      prompt: draft,
      providerInput: `${draft}\n\nTerminal context`,
      submissionTarget: "provider-turn",
      event: undefined,
      onSend,
    });

    expect(result).toEqual({
      validationMessage:
        "Prompt is 18 characters over the 120,000-character limit. Shorten or split it before sending.",
      didDispatch: false,
    });
    expect(draft).toHaveLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(onSend).not.toHaveBeenCalled();

    const correctedResult = submitComposerDraft({
      prompt: "Corrected prompt",
      providerInput: "Corrected prompt\n\nShort terminal context",
      submissionTarget: "provider-turn",
      event: undefined,
      onSend,
    });

    expect(correctedResult).toEqual({ validationMessage: null, didDispatch: true });
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("does not finish submission when the send boundary rejects composed provider input", () => {
    const preventDefault = vi.fn();

    const result = submitComposerDraft({
      prompt: "Sendable raw draft",
      submissionTarget: "provider-turn",
      event: { preventDefault },
      onSend: () => false,
    });

    expect(result).toEqual({ validationMessage: null, didDispatch: false });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("allows fully composed provider input at the shared character limit", () => {
    const onSend = vi.fn();

    const result = submitComposerDraft({
      prompt: "Short draft",
      providerInput: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
      submissionTarget: "provider-turn",
      event: undefined,
      onSend,
    });

    expect(result).toEqual({ validationMessage: null, didDispatch: true });
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("blocks a generated plan follow-up that exceeds the shared limit", () => {
    const onSend = vi.fn();

    const result = submitComposerDraft({
      prompt: "",
      providerInput: `PLEASE IMPLEMENT THIS PLAN:\n${"x".repeat(
        PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
      )}`,
      submissionTarget: "provider-turn",
      event: undefined,
      onSend,
    });

    expect(result.didDispatch).toBe(false);
    expect(result.validationMessage).toContain("over the 120,000-character limit");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("allows surrounding whitespace that the provider turn contract trims", () => {
    const draft = ` ${"x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)} `;
    const onSend = vi.fn();
    const preventDefault = vi.fn();

    const result = submitComposerDraft({
      prompt: draft,
      submissionTarget: "provider-turn",
      event: { preventDefault },
      onSend,
    });

    expect(result).toEqual({ validationMessage: null, didDispatch: true });
    expect(onSend).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("dispatches pending user input answers on their separate response path", () => {
    const answer = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1);
    const onSend = vi.fn();
    const preventDefault = vi.fn();

    const result = submitComposerDraft({
      prompt: answer,
      submissionTarget: "pending-user-input",
      event: { preventDefault },
      onSend,
    });

    expect(result).toEqual({ validationMessage: null, didDispatch: true });
    expect(onSend).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
