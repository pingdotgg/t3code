import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { createRef, useState } from "react";
import { expect, it } from "vite-plus/test";

import { page, userEvent } from "vite-plus/test/browser";

import {
  createCitationCommentInput,
  findAssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
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

it.each(["remove", "unmount"])(
  "releases pending citation input before subscription on %s",
  async (action) => {
    const editorRef = createRef<ComposerPromptEditorHandle>();
    await using screen = await render(<Composer question={false} editorRef={editorRef} />);
    const sourceAnchor = findAssistantCitationSourceAnchor(document, citation)!;
    sourceAnchor.commentInput = createCitationCommentInput("a");
    await act(async () => {
      editorRef.current?.requestCitationComment({
        previousValue: promptBefore,
        value: `${promptBefore}pending`,
        citationStart: "See ".length,
        sourceAnchor,
        insertedSpaces: { before: false, after: true },
      });
    });
    expect(sourceAnchor.commentInput.pending).toBe(true);
    await screen.rerender(
      action === "remove" ? <Composer question editorRef={editorRef} /> : <div />,
    );
    expect(sourceAnchor.commentInput.pending).toBe(false);
  },
);

function Composer({
  question,
  editorRef,
  initialPrompt = promptBefore,
}: {
  question: boolean;
  initialPrompt?: string;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
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
        editorRef={editorRef}
        value={question ? answer : prompt}
        cursor={0}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={(next) => (question ? setAnswer(next) : setPrompt(next))}
        onCitationDraftSave={(replacedValue, savedValue) => {
          if (replacedValue === prompt) setPrompt(savedValue);
        }}
        onPaste={() => {}}
      />
    </>
  );
}

it.each(["typed", "seeded"])(
  "keeps an unsaved %s citation comment when a question takes the composer",
  async (input) => {
    const editorRef = createRef<ComposerPromptEditorHandle>();
    await using screen = await render(<Composer question={false} editorRef={editorRef} />);
    const drafts = () => screen.container.querySelector("output")?.dataset;

    const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
    if (!sourceAnchor) throw new Error("Citation source did not resolve");
    if (input === "seeded") sourceAnchor.commentInput = createCitationCommentInput("check this");
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
    if (input === "typed") {
      await comment.click();
      await userEvent.keyboard("check this");
    }

    await screen.rerender(<Composer question editorRef={editorRef} />);
    expect(drafts()?.answer).toBe("");
    await screen.rerender(<Composer question={false} editorRef={editorRef} />);

    expect(drafts()?.prompt).toBe(
      `See ${serializeAssistantCitation(withAssistantCitationComment(citation, "check this"))} `,
    );
    await expect.element(page.getByLabelText("Edit citation comment")).toBeInTheDocument();
  },
);

it.each(["Escape", "Cancel"])("discards a seeded new citation with %s", async (action) => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);
  const sourceAnchor = findAssistantCitationSourceAnchor(document, citation)!;
  sourceAnchor.commentInput = createCitationCommentInput("unsaved comment");
  await act(async () =>
    editorRef.current?.requestCitationComment({
      previousValue: "See ",
      value: promptBefore,
      citationStart: "See ".length,
      sourceAnchor,
      insertedSpaces: { before: false, after: true },
    }),
  );
  await expect
    .element(page.getByLabelText("Comment on selected text"))
    .toHaveValue("unsaved comment");
  if (action === "Escape") await userEvent.keyboard("{Escape}");
  else await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(page.getByLabelText("Comment on selected text")).not.toBeInTheDocument();
  expect(screen.container.querySelector("output")?.dataset.prompt).toBe("See ");
  expect(sourceAnchor.commentInput.pending).toBe(false);
});

it("releases input when a 513-character message ID has no citation node", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using _screen = await render(<Composer question={false} editorRef={editorRef} />);
  const sourceAnchor = findAssistantCitationSourceAnchor(document, citation)!;
  sourceAnchor.commentInput = createCitationCommentInput("a");
  const value = serializeAssistantCitation({
    ...citation,
    messageId: MessageId.make("m".repeat(513)),
  });
  await _screen.rerender(
    <Composer question={false} editorRef={editorRef} initialPrompt={value} key="invalid" />,
  );
  await act(async () =>
    editorRef.current?.requestCitationComment({
      previousValue: "",
      value,
      citationStart: 0,
      sourceAnchor,
      insertedSpaces: { before: false, after: false },
    }),
  );
  expect(sourceAnchor.commentInput.pending).toBe(false);
});
