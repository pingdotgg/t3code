import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import {
  MAX_CITATION_HREF_LENGTH,
  formatAssistantCitationHref,
  parseAssistantCitationHref,
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { createRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { page, userEvent } from "vite-plus/test/browser";

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
  sourceCitation = citation,
  onSend = () => {},
}: {
  question: boolean;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  sourceCitation?: AssistantCitation;
  onSend?: () => void;
}) {
  const [prompt, setPrompt] = useState(() => `See ${serializeAssistantCitation(sourceCitation)} `);
  const [answer, setAnswer] = useState("");
  return (
    <>
      <div data-assistant-citation-viewport="">
        <p
          data-assistant-citation-source={sourceCitation.messageId}
          data-assistant-citation-environment={sourceCitation.environmentId}
          data-assistant-citation-thread={sourceCitation.threadId}
        >
          hello world
        </p>
      </div>
      <output data-prompt={prompt} data-answer={answer} />
      <ComposerPromptEditor
        editorRef={editorRef}
        value={question ? answer : prompt}
        cursor={0}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={(next) => (question ? setAnswer(next) : setPrompt(next))}
        onCitationSubmitAndSend={onSend}
        onCitationDraftSave={(replacedValue, savedValue) => {
          if (replacedValue === prompt) setPrompt(savedValue);
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

it.each([
  ["save", 100],
  ["send", 100],
  ["question", 100],
  ["save", 0],
] as const)(
  "rejects a comment exceeding the citation URL budget on %s (%i characters available)",
  async (action, availableSpace) => {
    const source = { ...citation, messageId: MessageId.make("界".repeat(17_750)) };
    const sourceCitation = {
      ...source,
      messageId: MessageId.make(
        source.messageId +
          "m".repeat(
            MAX_CITATION_HREF_LENGTH - formatAssistantCitationHref(source).length - availableSpace,
          ),
      ),
    };
    const oversizedComment = availableSpace === 0 ? "x" : "界".repeat(100);
    const prompt = `See ${serializeAssistantCitation(sourceCitation)} `;
    expect(parseAssistantCitationHref(formatAssistantCitationHref(sourceCitation))).toEqual(
      sourceCitation,
    );
    expect(
      parseAssistantCitationHref(
        formatAssistantCitationHref(withAssistantCitationComment(sourceCitation, oversizedComment)),
      ),
    ).toBeNull();

    const editorRef = createRef<ComposerPromptEditorHandle>();
    const onSend = vi.fn();
    await using screen = await render(
      <Composer
        question={false}
        editorRef={editorRef}
        sourceCitation={sourceCitation}
        onSend={onSend}
      />,
    );
    const sourceAnchor = findAssistantCitationSourceAnchor(document, sourceCitation);
    if (!sourceAnchor) throw new Error("Citation source did not resolve");
    await act(async () =>
      editorRef.current?.requestCitationComment({
        previousValue: "See ",
        value: prompt,
        citationStart: "See ".length,
        sourceAnchor,
        insertedSpaces: { before: false, after: true },
      }),
    );
    const comment = page.getByLabelText("Comment on selected text");
    await expect.element(comment).toBeVisible();
    await comment.fill(oversizedComment);
    await expect.element(comment).toHaveAttribute("aria-invalid", "true");
    const error = page.getByText(
      "The citation link is too long. Shorten the comment or quoted text.",
    );
    await expect.element(error).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

    if (action === "question") {
      await screen.rerender(
        <Composer question editorRef={editorRef} sourceCitation={sourceCitation} onSend={onSend} />,
      );
    } else {
      await userEvent.keyboard(action === "send" ? "{Control>}{Enter}{/Control}" : "{Enter}");
    }
    await vi.waitFor(() => {
      const savedPrompt = screen.container.querySelector("output")?.dataset.prompt;
      expect(
        savedPrompt === prompt,
        "Rejected comments must leave the saved prompt unchanged",
      ).toBe(true);
      expect(onSend).not.toHaveBeenCalled();
    });
    if (action !== "question") {
      await expect.element(comment).toHaveValue(oversizedComment);
      const acceptedComment = availableSpace === 0 ? "" : "ok";
      await comment.fill(acceptedComment);
      await expect.element(comment).not.toHaveAttribute("aria-invalid", "true");
      await expect.element(error).not.toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      await userEvent.keyboard(action === "send" ? "{Control>}{Enter}{/Control}" : "{Enter}");
      await vi.waitFor(() => {
        expect(screen.container.querySelector("output")?.dataset.prompt).toBe(
          `See ${serializeAssistantCitation(withAssistantCitationComment(sourceCitation, acceptedComment))} `,
        );
        expect(onSend).toHaveBeenCalledTimes(action === "send" ? 1 : 0);
      });
    }
  },
);
