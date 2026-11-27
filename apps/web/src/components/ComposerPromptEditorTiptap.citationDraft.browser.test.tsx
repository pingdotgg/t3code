import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { createRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { cdp, page, userEvent } from "vite-plus/test/browser";

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
  initialPrompt = promptBefore,
}: {
  question: boolean;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  disabled?: boolean;
  send?: "clears" | "blocked" | "refusedLater";
  initialPrompt?: string;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [promptCursor, setPromptCursor] = useState(0);
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
        cursor={question ? 0 : promptCursor}
        contextRecords={new Map()}
        skills={[]}
        disabled={disabled}
        placeholder=""
        onChange={(next, cursor) => {
          if (question) {
            setAnswer(next);
          } else {
            setPrompt(next);
            setPromptCursor(cursor);
          }
        }}
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
      .toHaveAttribute("data-prompt", `See ${serializeAssistantCitation(citation)} x`);
  },
);

it.each([
  { input: "typing", text: "x", expected: " x world", blocked: false },
  { input: "pasting", text: "hello", expected: " hello world", blocked: false },
  {
    input: "pasting paragraphs",
    text: "hello\n\nthere",
    expected: "\nhello\n\nthere\n world",
    blocked: false,
  },
  { input: "typing", text: "x", expected: " x world", blocked: false, trailing: "  world" },
  { input: "composing", text: "あ", expected: " あ world", blocked: false },
  { input: "leaving the composer", text: "", expected: " world", blocked: false },
  { input: "typing punctuation", text: ",", expected: ", world", blocked: false },
  { input: "moving the caret and returning", text: "x", expected: "x world", blocked: false },
  { input: "typing", text: "x", expected: " x world", blocked: true },
] as const)(
  "keeps citation spacing when $input after saving (send blocked: $blocked)",
  async ({ input, text, expected, blocked, ...row }) => {
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const promptMidText = `See ${serializeAssistantCitation(citation)}${"trailing" in row ? row.trailing : " world"}`;
    await using screen = await render(
      <Composer
        question={false}
        editorRef={editorRef}
        initialPrompt={promptMidText}
        send={blocked ? "blocked" : "clears"}
      />,
    );

    const sourceAnchor = findAssistantCitationSourceAnchor(document, citation);
    if (!sourceAnchor) throw new Error("Citation source did not resolve");
    await act(async () =>
      editorRef.current?.requestCitationComment({
        previousValue: "See world",
        value: promptMidText,
        citationStart: "See ".length,
        sourceAnchor,
        insertedSpaces: { before: false, after: true },
      }),
    );
    const comment = page.getByLabelText("Comment on selected text");
    await expect.element(comment).toHaveFocus();
    await userEvent.keyboard(blocked ? "note{Control>}{Enter}{/Control}" : "note{Enter}");
    await expect.element(comment).not.toBeInTheDocument();
    const composer = page.getByTestId("composer-editor");
    await expect.element(composer).toHaveFocus();
    switch (input) {
      case "typing":
      case "typing punctuation":
        await userEvent.keyboard(text);
        break;
      case "leaving the composer":
        await page.getByText("hello world", { exact: true }).click();
        await expect.element(composer).not.toHaveFocus();
        break;
      case "moving the caret and returning":
        await act(async () => editorRef.current?.focusAtEnd());
        await userEvent.keyboard("{ArrowLeft>6/}");
        await userEvent.keyboard(text);
        break;
      case "pasting":
      case "pasting paragraphs": {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", text);
        composer
          .element()
          .dispatchEvent(new ClipboardEvent("paste", { clipboardData, cancelable: true }));
        break;
      }
      case "composing": {
        const session = cdp();
        await session.send("Input.imeSetComposition", {
          text: "a",
          selectionStart: 1,
          selectionEnd: 1,
        });
        await session.send("Input.insertText", { text });
        break;
      }
    }

    await expect
      .element(screen.getByRole("status"))
      .toHaveAttribute(
        "data-prompt",
        `See ${serializeAssistantCitation(withAssistantCitationComment(citation, "note"))}${expected}`,
      );
  },
);

it("lets punctuation touch a citation at a manually placed caret", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(
    <Composer question={false} editorRef={editorRef} initialPrompt={`${promptBefore}world`} />,
  );

  await act(async () => editorRef.current?.focusAtEnd());
  await expect.element(page.getByTestId("composer-editor")).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft>6/},");
  await expect
    .element(screen.getByRole("status"))
    .toHaveAttribute("data-prompt", `See ${serializeAssistantCitation(citation)}, world`);
});

it("keeps the citation when typing after its link opens the cited text", async () => {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  await using screen = await render(<Composer question={false} editorRef={editorRef} />);

  await act(async () => editorRef.current?.focusAtEnd());
  const link = page.getByRole("link", { name: "View cited assistant text: hello" });
  await link.click();
  await userEvent.keyboard("x");

  await expect.element(link).toHaveFocus();
  expect(screen.container.querySelector("output")?.dataset.prompt).toBe(promptBefore);
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/environment/thread"),
  );
});

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
