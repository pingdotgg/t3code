import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { createRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { page, userEvent } from "vite-plus/test/browser";

const navigation = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { environmentId: "environment", threadId: "thread" },
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => navigation.navigate,
  useParams: (() => navigation.params) as typeof import("@tanstack/react-router").useParams,
}));

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
  send = "clears",
}: {
  question: boolean;
  sourceVisible?: boolean;
  onCommandKeyDown?: (key: string, event: KeyboardEvent) => boolean;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  send?: "clears" | "blocked" | "refusedLater";
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
    chip.element().focus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onCommandKeyDown).not.toHaveBeenCalled();
    for (const init of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
      // Keep the browser on the test page while exercising the link's modifier handling.
      chip.element().addEventListener("click", (event) => event.preventDefault(), { once: true });
      await act(() => {
        chip.element().dispatchEvent(event);
      });
      await expect.element(page.getByLabelText("Comment on selected text")).not.toBeInTheDocument();
    }
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
    chip.element().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    chip.element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await expect.element(page.getByLabelText("Comment on selected text")).toBeVisible();
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
  source.style.position = "fixed";
  source.style.left = "500px";
  source.style.top = "300px";
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
    const popup = page.getByRole("dialog").element().getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    const chipRect = screen
      .getByRole("link", { name: "View cited assistant text: hello" })
      .element()
      .getBoundingClientRect();
    const distance = (rect: DOMRect) => Math.hypot(popup.left - rect.left, popup.top - rect.bottom);
    expect(distance(sourceRect)).toBeLessThan(distance(chipRect));
  });
});

it.each([
  ["environment", "other-thread", "click"],
  ["environment", "other-thread", "Enter"],
  ["environment", "other-thread", " "],
  ["other-environment", "thread", "click"],
  ["other-environment", "thread", "Enter"],
  ["other-environment", "thread", " "],
])(
  "edits a citation from draft %s/%s with %s without navigating",
  async (environmentId, threadId, activation) => {
    navigation.navigate.mockClear();
    navigation.params = { environmentId, threadId };
    try {
      const editorRef = createRef<ComposerPromptEditorHandle>();
      await using screen = await render(
        <Composer question={false} editorRef={editorRef} sourceVisible={false} />,
      );
      const chip = screen.getByRole("link", { name: "View cited assistant text: hello" });
      if (activation === "click") {
        await chip.click();
      } else {
        chip.element().focus();
        await userEvent.keyboard(activation === "Enter" ? "{Enter}" : " ");
      }
      await expect.element(page.getByLabelText("Comment on selected text")).toBeVisible();
      expect(navigation.navigate).not.toHaveBeenCalled();
    } finally {
      navigation.params = { environmentId: "environment", threadId: "thread" };
    }
  },
);

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
