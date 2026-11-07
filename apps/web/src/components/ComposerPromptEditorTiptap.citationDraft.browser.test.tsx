import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { createRef, useState } from "react";
import { expect, it } from "vite-plus/test";

import { page, userEvent } from "vite-plus/test/browser";

import { findAssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { act, render } from "../../test/render";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

import { AssistantCitationMarkers } from "./chat/AssistantCitationMarkers";

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
  initialPrompt = promptBefore,
}: {
  question: boolean;
  initialPrompt?: string;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [answer, setAnswer] = useState("");
  return (
    <>
      <div ref={setViewport} className="relative" data-assistant-citation-viewport="">
        <p
          data-assistant-citation-source={citation.messageId}
          data-assistant-citation-environment={citation.environmentId}
          data-assistant-citation-thread={citation.threadId}
        >
          hello world
        </p>
        <AssistantCitationMarkers
          viewport={viewport}
          prompt={question ? answer : prompt}
          onOpen={(key, anchor) => editorRef.current?.openCitation(key, anchor)}
        />
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

it("opens the existing comment at its source from a draft marker", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);
  await userEvent.click(screen.getByRole("button", { name: "Edit citation 1 comment" }));
  await expect.element(page.getByLabelText("Comment on selected text")).toBeVisible();
  expect(screen.container.querySelector("output")?.dataset.prompt).toBe(promptBefore);
});

it("opens each duplicate marker's own comment and restores marker focus", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const first = withAssistantCitationComment(citation, "first");
  const second = withAssistantCitationComment(citation, "second");
  await using screen = await render(
    <Composer
      question={false}
      editorRef={editorRef}
      initialPrompt={`${serializeAssistantCitation(first)} ${serializeAssistantCitation(second)}`}
    />,
  );
  const one = screen.getByRole("button", { name: "Edit citation 1 comment" });
  const two = screen.getByRole("button", { name: "Edit citation 2 comment" });
  await expect.element(one).toBeVisible();
  await expect.element(two).toBeVisible();
  const firstButton = screen.container.querySelector<HTMLElement>("[data-citation-marker-key]")!;
  const secondButton = screen.container.querySelectorAll<HTMLElement>(
    "[data-citation-marker-key]",
  )[1]!;
  expect(firstButton.getBoundingClientRect().left).not.toBe(
    secondButton.getBoundingClientRect().left,
  );
  await userEvent.click(one);
  await expect.element(page.getByLabelText("Comment on selected text")).toHaveValue("first");
  await userEvent.keyboard("{Escape}");
  await expect.element(one).toHaveFocus();
  await userEvent.click(two);
  await expect.element(page.getByLabelText("Comment on selected text")).toHaveValue("second");
});
