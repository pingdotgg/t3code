import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { createRef, useState } from "react";
import { expect, it } from "vite-plus/test";

import { page, userEvent } from "vite-plus/test/browser";

import { findAssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { isMacPlatform } from "~/lib/utils";
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
}: {
  question: boolean;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
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

it("Cancel keeps a fresh citation and discards edits", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);
  const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
  if (!sourceAnchor) throw new Error("Citation source did not resolve");
  await act(async () =>
    editorRef.current?.requestCitationComment({
      sourceAnchor,
      previousValue: "See ",
      value: promptBefore,
      citationStart: "See ".length,
      insertedSpaces: { before: false, after: true },
    }),
  );
  const comment = page.getByLabelText("Comment on selected text");
  await expect.element(comment).toBeVisible();
  await comment.fill("unsaved");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(comment).not.toBeInTheDocument();
  expect(screen.container.querySelector("output")?.dataset.prompt).toBe(promptBefore);
  await page.getByRole("button", { name: "Add comment to citation" }).click();
  await expect.element(comment).toHaveValue("");
  await comment.fill("saved comment");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Edit citation comment", exact: true }).click();
  await comment.fill("discard this edit");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit citation comment", exact: true }).click();
  await expect.element(comment).toHaveValue("saved comment");
});

it("Delete citation removes a fresh citation and its inserted space, and undo restores it", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);
  const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
  if (!sourceAnchor) throw new Error("Citation source did not resolve");
  await act(async () =>
    editorRef.current?.requestCitationComment({
      sourceAnchor,
      previousValue: "See ",
      value: promptBefore,
      citationStart: "See ".length,
      insertedSpaces: { before: false, after: true },
    }),
  );
  const comment = page.getByLabelText("Comment on selected text");
  await expect.element(comment).toBeVisible();
  await comment.fill("unsaved");
  await page.getByRole("button", { name: "Delete citation", exact: true }).click();
  await expect.element(comment).not.toBeInTheDocument();
  await expect
    .element(page.elementLocator(screen.container.querySelector("output")!))
    .toHaveAttribute("data-prompt", "See ");
  await userEvent.keyboard(
    isMacPlatform(navigator.platform) ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  await expect
    .element(page.elementLocator(screen.container.querySelector("output")!))
    .toHaveAttribute("data-prompt", promptBefore);
  await expect.element(comment).not.toBeInTheDocument();
});

it("deletes an existing citation without removing surrounding spaces", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);
  await page.getByRole("button", { name: "Add comment to citation" }).click();
  await page.getByRole("button", { name: "Delete citation" }).click();
  await expect
    .element(page.elementLocator(screen.container.querySelector("output")!))
    .toHaveAttribute("data-prompt", "See  ");
});
