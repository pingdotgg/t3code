import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

const prompt: PendingUserInput = {
  requestId: ApprovalRequestId.make("request-1"),
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
};

const multiSelectPrompt: PendingUserInput = {
  requestId: ApprovalRequestId.make("request-2"),
  createdAt: "2026-08-15T00:00:00.000Z",
  questions: [
    {
      id: "question-2",
      header: "Surfaces",
      question: "Which surfaces should ship the change?",
      options: [
        { label: "Web", description: "The browser client" },
        { label: "Mobile", description: "The React Native client" },
      ],
      multiSelect: true,
    },
  ],
};

function renderPanel(
  input: PendingUserInput = prompt,
  answers: Record<string, { selectedOptionLabels?: string[]; customAnswer?: string }> = {},
) {
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[input]}
      respondingRequestIds={[]}
      answers={answers}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
    />,
  );
}

describe("ComposerPendingUserInputPanel", () => {
  it("renders the header as a disclosure control for the question body", () => {
    const markup = renderPanel();

    const toggle = markup.match(/<button[^>]*data-pending-user-input-toggle="[^"]*"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain('data-pending-user-input-toggle="expanded"');
    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain('type="button"');

    const controlledId = toggle?.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeDefined();
    expect(markup).toMatch(new RegExp(`<div[^>]*\\sid="${controlledId}"`));
  });

  it("starts expanded so the question and its options are visible", () => {
    const markup = renderPanel();

    expect(markup).toContain("Approach");
    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("Big bang");
  });

  it("announces multi-select options as checkboxes and keeps their shortcuts", () => {
    const markup = renderPanel(multiSelectPrompt, {
      "question-2": { selectedOptionLabels: ["Web"] },
    });

    const optionButtons = markup.match(/<button[^>]*role="checkbox"[^>]*>/g) ?? [];
    expect(optionButtons).toHaveLength(2);
    expect(optionButtons[0]).toContain('aria-checked="true"');
    expect(optionButtons[1]).toContain('aria-checked="false"');
    // The trailing number shortcut survives selection, so every option stays
    // reachable from the keyboard while the answer is being assembled.
    expect(markup).toContain("<kbd");
    expect(markup).toContain("Select one or more options.");
  });

  it("leaves single-select options without checkbox semantics", () => {
    const markup = renderPanel(prompt, { "question-1": { selectedOptionLabels: ["Incremental"] } });

    expect(markup).not.toContain('role="checkbox"');
    expect(markup).not.toContain("Select one or more options.");
  });
});
