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

it.each(["code block", "literal answer"])(
  "falls back to composer text when a %s cannot contain a citation",
  async (mode) => {
    const editorRef = createRef<ComposerPromptEditorHandle>();
    const code = "```\ncode\n```";
    const question = mode === "literal answer";
    await using screen = await render(
      <Composer
        question={question}
        literalText={question}
        editorRef={editorRef}
        initialPrompt={code}
      />,
    );
    await act(async () => editorRef.current?.focusAt(0));
    expect(editorRef.current?.canInsertCitation()).toBe(false);
    await userEvent.keyboard("x");
    const drafts = screen.container.querySelector("output")?.dataset;
    expect(question ? drafts?.answer : drafts?.prompt).toBe(question ? "x" : "```\nxcode\n```");
  },
);

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
  literalText = false,
  send = "clears",
}: {
  question: boolean;
  initialPrompt?: string;
  literalText?: boolean;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  send?: "clears" | "blocked" | "refusedLater";
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
        richTextEnabled
        literalText={literalText}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
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
