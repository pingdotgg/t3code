import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
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
  sourceVisible = true,
  onCommandKeyDown,
}: {
  question: boolean;
  sourceVisible?: boolean;
  onCommandKeyDown?: (key: string, event: KeyboardEvent) => boolean;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
}) {
  const [prompt, setPrompt] = useState(promptBefore);
  const [answer, setAnswer] = useState("");
  return (
    <>
      {sourceVisible ? (
        <div data-assistant-citation-viewport="">
          <p
            data-assistant-citation-source={citation.messageId}
            data-assistant-citation-environment={citation.environmentId}
            data-assistant-citation-thread={citation.threadId}
          >
            hello world
          </p>
        </div>
      ) : null}
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
        {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
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
  await expect
    .element(page.getByRole("link", { name: "View cited assistant text: check this" }))
    .toBeInTheDocument();
});

it.each(["click", "Enter", " "])(
  "opens the citation comment editor with %s on the chip",
  async (activation) => {
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const onCommandKeyDown = vi.fn(() => true);
    await using screen = await render(
      <Composer question={false} editorRef={editorRef} onCommandKeyDown={onCommandKeyDown} />,
    );
    const textbox = screen.getByRole("textbox");
    await textbox.click();
    await userEvent.keyboard("{Enter}");
    expect(onCommandKeyDown).toHaveBeenCalledWith("Enter", expect.any(KeyboardEvent), false);
    onCommandKeyDown.mockClear();
    const chip = screen.getByRole("link", { name: "View cited assistant text: hello" });
    if (activation === "click") {
      await chip.click();
    } else {
      screen.container.querySelector<HTMLElement>("[data-citation-comment-trigger]")?.focus();
      await userEvent.keyboard(activation === "Enter" ? "{Enter}" : " ");
    }
    await expect.element(page.getByLabelText("Comment on selected text")).toBeVisible();
    expect(chip.element().getAttribute("aria-controls")).toBe(
      page.getByRole("dialog").element().id,
    );
    await act(() => {
      chip.element().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      chip.element().click();
    });
    await expect.element(page.getByLabelText("Comment on selected text")).not.toBeVisible();
    for (const init of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      await act(() => {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
        // Keep the browser on the test page while exercising the link's modifier handling.
        chip.element().addEventListener("click", (event) => event.preventDefault(), { once: true });
        chip.element().dispatchEvent(event);
      });
      await expect.element(page.getByLabelText("Comment on selected text")).not.toBeVisible();
    }
    expect(onCommandKeyDown).not.toHaveBeenCalled();
    expect(screen.container.querySelector("output")?.dataset.prompt).toBe(promptBefore);
  },
);

it("reanchors the comment when the cited source mounts after activation", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(
    <Composer question={false} editorRef={editorRef} sourceVisible={false} />,
  );
  await screen.getByRole("link", { name: "View cited assistant text: hello" }).click();
  await expect.element(page.getByLabelText("Comment on selected text")).toBeVisible();
  const viewport = document.createElement("div");
  viewport.dataset.assistantCitationViewport = "";
  const source = document.createElement("p");
  source.dataset.assistantCitationSource = citation.messageId;
  source.dataset.assistantCitationEnvironment = citation.environmentId;
  source.dataset.assistantCitationThread = citation.threadId;
  source.textContent = "hello world";
  viewport.append(source);
  await act(() => {
    screen.container.append(viewport);
  });
  await vi.waitFor(() => {
    const highlight = CSS.highlights.get("t3-assistant-citation-comment");
    expect(highlight?.size).toBe(1);
    expect(highlight && [...highlight][0]?.startContainer.parentElement).toBe(source);
  });
});
