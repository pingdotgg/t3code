import { AssistantCitationTray } from "./chat/AssistantCitationTray";
import { type AssistantCitation, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { createRef, useRef, useState } from "react";
import { expect, it } from "vite-plus/test";

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

function TrayComposer({ question = false }: { question?: boolean }) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [prompt, setPrompt] = useState(promptBefore);
  const [answer, setAnswer] = useState("");
  const [tray, setTray] = useState<ReadonlyArray<AssistantCitation>>([]);
  return (
    <>
      <output data-tray-count={tray.length} data-prompt={prompt} />
      <AssistantCitationTray
        citations={tray}
        onChange={setTray}
        onInsertInline={
          question
            ? undefined
            : (item) => {
                setPrompt((text) => `${text}${serializeAssistantCitation(item)}`);
                return true;
              }
        }
      />
      <ComposerPromptEditor
        editorRef={editorRef}
        value={question ? answer : prompt}
        cursor={0}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={question ? setAnswer : setPrompt}
        onPaste={() => {}}
        onMoveCitationToTray={question ? undefined : (item) => setTray((items) => [...items, item])}
      />
    </>
  );
}

it("moves a citation and its edited comment from inline to tray and back", async () => {
  await using screen = await render(<TrayComposer />);
  await page.getByLabelText("Add comment to citation").click();
  await page.getByLabelText("Comment on selected text").fill("Keep this comment");
  await page.getByRole("button", { name: "Move to tray", exact: true }).click();
  const state = () => screen.container.querySelector("output")?.dataset;
  expect(state()?.trayCount).toBe("1");
  expect(state()?.prompt).not.toContain("t3-citation");
  await page.getByRole("button", { name: "1 annotation", exact: true }).click();
  await screen.rerender(<TrayComposer question />);
  await expect
    .element(page.getByRole("button", { name: "Insert annotation 1 inline", exact: true }))
    .not.toBeInTheDocument();
  expect(state()?.trayCount).toBe("1");
  await screen.rerender(<TrayComposer />);
  await page.getByRole("button", { name: "Insert annotation 1 inline", exact: true }).click();
  expect(state()?.trayCount).toBe("0");
  expect(state()?.prompt).toContain(
    serializeAssistantCitation(withAssistantCitationComment(citation, "Keep this comment")),
  );
});
