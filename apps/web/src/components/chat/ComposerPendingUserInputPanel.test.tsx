import { ApprovalRequestId } from "@t3tools/contracts";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

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
  dismissible: true,
};

function renderPanel(pendingUserInput: PendingUserInput = prompt) {
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[pendingUserInput]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
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

  it("offers dismiss only for async questions", () => {
    expect(renderPanel()).toContain("data-pending-user-input-dismiss");
    expect(renderPanel({ ...prompt, dismissible: false })).not.toContain(
      "data-pending-user-input-dismiss",
    );
  });

  it("starts expanded so the question and its options are visible", () => {
    const markup = renderPanel();

    expect(markup).toContain("Approach");
    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("Big bang");
  });

  it("auto-directs Hebrew question content with English technical terms", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const hebrewPrompt: PendingUserInput = {
      ...prompt,
      questions: [
        {
          ...prompt.questions[0]!,
          header: "בחירת גישה",
          question: "React Server Components האם להשתמש בהם בפרויקט החדש שלנו?",
          options: [
            { label: "כן, להשתמש ב-RSC", description: "מתאים ל-Next.js App Router" },
            { label: "Client Components", description: "להשאיר את הממשק בצד הלקוח" },
          ],
        },
      ],
    };
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <ComposerPendingUserInputPanel
            pendingUserInputs={[hebrewPrompt]}
            respondingRequestIds={[]}
            answers={{}}
            questionIndex={0}
            onToggleOption={() => {}}
            onAdvance={() => {}}
            onDismiss={() => {}}
          />,
        );
      });

      for (const [text, direction] of [
        ["בחירת גישה", "rtl"],
        ["React Server Components האם להשתמש בהם בפרויקט החדש שלנו?", "rtl"],
        ["כן, להשתמש ב-RSC", "rtl"],
        ["מתאים ל-Next.js App Router", "rtl"],
        ["Client Components", "ltr"],
        ["להשאיר את הממשק בצד הלקוח", "rtl"],
      ] as const) {
        expect(
          renderer!.root.find(
            (node) => node.props.dir === direction && node.children.includes(text),
          ),
        ).toBeDefined();
      }
      expect(
        renderer!.root.findAll(
          (node) =>
            node.type === "button" &&
            typeof node.props.className === "string" &&
            node.props.className.includes("px-2.5 py-2 text-start"),
        ),
      ).toHaveLength(2);

      const toggle = renderer!.root.find(
        (node) =>
          node.type === "button" && node.props["data-pending-user-input-toggle"] === "expanded",
      );
      await act(() => toggle.props.onClick({ nativeEvent: {} }));
      expect(
        renderer!.root.find(
          (node) =>
            node.props.dir === "rtl" &&
            String(node.props.className).includes("truncate") &&
            node.children.includes("React Server Components האם להשתמש בהם בפרויקט החדש שלנו?"),
        ),
      ).toBeDefined();
    } finally {
      await act(() => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});
