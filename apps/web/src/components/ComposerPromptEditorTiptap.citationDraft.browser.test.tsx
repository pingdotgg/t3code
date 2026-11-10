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
  richTextEnabled = false,
  disabled = false,
  send = "clears",
}: {
  question: boolean;
  initialPrompt?: string;
  richTextEnabled?: boolean;
  disabled?: boolean;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  send?: "clears" | "blocked" | "refusedLater";
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
          prompt={prompt}
          richTextEnabled={richTextEnabled}
          showingDraft={!question}
          onOpen={(key, anchor) => editorRef.current?.openCitation(key, anchor)}
        />
      </div>
      <output data-prompt={prompt} data-answer={answer} />
      <ComposerPromptEditor
        editorRef={editorRef}
        richTextEnabled={richTextEnabled}
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
  await expect
    .element(page.getByRole("button", { name: "Edit citation 1 comment" }))
    .not.toBeInTheDocument();
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
  await userEvent.keyboard("{Escape}");
  await screen.rerender(<Composer question={false} editorRef={editorRef} disabled />);
  await userEvent.click(screen.getByRole("button", { name: "Edit citation 1 comment" }));
  await expect.element(page.getByLabelText("Comment on selected text")).not.toBeInTheDocument();
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
  await userEvent.click(one);
  await expect.element(page.getByLabelText("Comment on selected text")).toHaveValue("first");
  await userEvent.keyboard("{Escape}");
  await expect.element(one).toHaveFocus();
  await userEvent.click(two);
  await expect.element(page.getByLabelText("Comment on selected text")).toHaveValue("second");
});

it("matches the editor citation nodes when rich text is toggled", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const initialPrompt = "```text\n" + serializeAssistantCitation(citation) + "\n```";
  await using screen = await render(
    <Composer question={false} editorRef={editorRef} initialPrompt={initialPrompt} />,
  );
  const marker = page.getByRole("button", { name: "Edit citation 1 comment" });
  await expect.element(marker).toBeVisible();
  await marker.click();
  await expect.element(page.getByLabelText("Comment on selected text")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await screen.rerender(
    <Composer
      question={false}
      editorRef={editorRef}
      initialPrompt={initialPrompt}
      richTextEnabled
    />,
  );
  await expect.element(marker).not.toBeInTheDocument();
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
