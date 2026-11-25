import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { createRef, useLayoutEffect, useRef, useState } from "react";
import { expect, it } from "vite-plus/test";

import { page, userEvent } from "vite-plus/test/browser";

import {
  DraftId,
  composerTargetKey,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "~/composerDraftStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { findAssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { act, render } from "../../test/render";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};
const promptBefore = `See ${serializeAssistantCitation(citation)} `;

function Composer({
  question,
  editorRef,
  disabled = false,
  send = "clears",
}: {
  question: boolean;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  disabled?: boolean;
  send?: "clears" | "blocked" | "refusedLater";
}) {
  const [prompt, setPrompt] = useState(promptBefore);
  const [answer, setAnswer] = useState("");
  return (
    <>
      <div data-assistant-citation-viewport="">
        <p
          data-assistant-citation-source={citation.messageId}
          data-assistant-citation-environment={citation.environmentId}
          data-assistant-citation-thread={citation.threadId}
        >
          hello world
        </p>
      </div>
      <output data-prompt={prompt} data-answer={answer} />
      <ComposerPromptEditor
        draftKey={question ? "question-0" : "thread-draft"}
        editorRef={editorRef}
        value={question ? answer : prompt}
        cursor={0}
        contextRecords={new Map()}
        skills={[]}
        disabled={disabled}
        placeholder=""
        onChange={(next) => (question ? setAnswer(next) : setPrompt(next))}
        onCitationDraftSave={(replacedValue, savedValue) => {
          if (replacedValue === prompt) setPrompt(savedValue);
        }}
        onCitationSubmitAndSend={() => {
          if (send === "blocked") return false;
          if (send === "clears") setPrompt("");
          return true;
        }}
        onPaste={() => {}}
      />
    </>
  );
}

it("keeps an unsaved citation comment when a question takes the composer", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);
  const drafts = () => screen.container.querySelector("output")?.dataset;

  const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
  if (!sourceAnchor) throw new Error("Citation source did not resolve");
  await act(async () =>
    editorRef.current?.requestCitationComment({
      previousValue: "See ",
      value: promptBefore,
      citationStart: "See ".length,
      sourceAnchor,
      insertedSpaces: { before: false, after: true },
    }),
  );
  const comment = page.getByLabelText("Comment on selected text");
  await expect.element(comment).toBeVisible();
  await comment.click();
  await userEvent.keyboard("check this");

  await screen.rerender(<Composer question editorRef={editorRef} />);
  expect(drafts()?.answer).toBe("");
  await screen.rerender(<Composer question={false} editorRef={editorRef} />);

  expect(drafts()?.prompt).toBe(
    `See ${serializeAssistantCitation(withAssistantCitationComment(citation, "check this"))} `,
  );
  await expect.element(page.getByLabelText("Edit citation comment")).toBeInTheDocument();
});

it("clears the sent prompt when an empty citation comment sends it", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);

  const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
  if (!sourceAnchor) throw new Error("Citation source did not resolve");
  await act(async () =>
    editorRef.current?.requestCitationComment({
      previousValue: "See ",
      value: promptBefore,
      citationStart: "See ".length,
      sourceAnchor,
      insertedSpaces: { before: false, after: true },
    }),
  );
  const comment = page.getByLabelText("Comment on selected text");
  await expect.element(comment).toHaveFocus();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");

  await expect.element(comment).not.toBeInTheDocument();
  await expect.element(page.getByTestId("composer-editor")).toHaveFocus();
  await expect.element(screen.getByRole("status")).toHaveAttribute("data-prompt", "");
});

it.each(["blocked", "refusedLater"] as const)(
  "keeps the caret after the citation when save-and-send is %s",
  async (send) => {
    const editorRef = createRef<ComposerPromptEditorHandle>();
    await using screen = await render(
      <Composer question={false} editorRef={editorRef} send={send} />,
    );

    const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
    if (!sourceAnchor) throw new Error("Citation source did not resolve");
    await act(async () =>
      editorRef.current?.requestCitationComment({
        previousValue: "See ",
        value: promptBefore,
        citationStart: "See ".length,
        sourceAnchor,
        insertedSpaces: { before: false, after: true },
      }),
    );
    const comment = page.getByLabelText("Comment on selected text");
    await expect.element(comment).toHaveFocus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.element(comment).not.toBeInTheDocument();
    await userEvent.keyboard("x");

    await expect
      .element(screen.getByRole("status"))
      .toHaveAttribute("data-prompt", `See ${serializeAssistantCitation(citation)}x `);
  },
);

it("cancels a new citation while dictation makes the composer read-only", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} disabled />);

  const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
  if (!sourceAnchor) throw new Error("Citation source did not resolve");
  await act(async () =>
    editorRef.current?.requestCitationComment({
      previousValue: "See ",
      value: promptBefore,
      citationStart: "See ".length,
      sourceAnchor,
      insertedSpaces: { before: false, after: true },
    }),
  );
  await expect.element(page.getByLabelText("Comment on selected text")).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();

  await expect.element(page.getByLabelText("Comment on selected text")).not.toBeInTheDocument();
  expect(screen.container.querySelector("output")?.dataset.prompt).toBe("See ");
});

it.each([
  { label: "different prompts", incomingPrompt: "Other draft" },
  { label: "identical prompts", incomingPrompt: promptBefore },
])(
  "saves an unsaved citation comment into the outgoing store draft when switching drafts with $label",
  async ({ incomingPrompt }) => {
    const draftA = DraftId.make(`citation-owner-a-${incomingPrompt.length}`);
    const draftB = DraftId.make(`citation-owner-b-${incomingPrompt.length}`);
    useComposerDraftStore.getState().setPrompt(draftA, promptBefore);
    useComposerDraftStore.getState().setPrompt(draftB, incomingPrompt);

    const editorRef = createRef<ComposerPromptEditorHandle>();

    function TwoDraftHarness({ activeTarget }: { activeTarget: DraftId }) {
      const targetKey = composerTargetKey(activeTarget);
      const draft = useComposerThreadDraft(activeTarget);
      const promptRef = useRef(draft.prompt);
      const committedOwnerRef = useRef({ target: activeTarget, key: targetKey });
      useLayoutEffect(() => {
        committedOwnerRef.current = { target: activeTarget, key: targetKey };
      });
      const saveCitationDraftToPrompt = useStableCallback(
        (replacedValue: string, savedValue: string) => {
          const owner = committedOwnerRef.current;
          const livePrompt =
            useComposerDraftStore.getState().getComposerDraft(owner.target)?.prompt ?? "";
          if (replacedValue !== livePrompt) return;
          if (owner.key === targetKey && promptRef.current === replacedValue) {
            promptRef.current = savedValue;
          }
          useComposerDraftStore.getState().setPrompt(owner.target, savedValue);
        },
      );

      return (
        <>
          <div data-assistant-citation-viewport="">
            <p
              data-assistant-citation-source={citation.messageId}
              data-assistant-citation-environment={citation.environmentId}
              data-assistant-citation-thread={citation.threadId}
            >
              hello world
            </p>
          </div>
          <ComposerPromptEditor
            draftKey={targetKey}
            editorRef={editorRef}
            value={draft.prompt}
            cursor={draft.prompt.length}
            richTextEnabled
            contextRecords={new Map()}
            skills={[]}
            disabled={false}
            placeholder=""
            onChange={(next) => {
              promptRef.current = next;
              useComposerDraftStore.getState().setPrompt(activeTarget, next);
            }}
            onCitationDraftSave={saveCitationDraftToPrompt}
            onPaste={() => {}}
          />
        </>
      );
    }

    await using screen = await render(<TwoDraftHarness activeTarget={draftA} />);
    const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
    if (!sourceAnchor) throw new Error("Citation source did not resolve");
    await act(async () =>
      editorRef.current?.requestCitationComment({
        previousValue: "See ",
        value: promptBefore,
        citationStart: "See ".length,
        sourceAnchor,
        insertedSpaces: { before: false, after: true },
      }),
    );
    const comment = page.getByLabelText("Comment on selected text");
    await expect.element(comment).toBeVisible();
    await comment.click();
    await userEvent.keyboard("save to A");

    await screen.rerender(<TwoDraftHarness activeTarget={draftB} />);

    expect(useComposerDraftStore.getState().getComposerDraft(draftA)?.prompt).toBe(
      `See ${serializeAssistantCitation(withAssistantCitationComment(citation, "save to A"))} `,
    );
    expect(useComposerDraftStore.getState().getComposerDraft(draftB)?.prompt).toBe(incomingPrompt);
  },
);
