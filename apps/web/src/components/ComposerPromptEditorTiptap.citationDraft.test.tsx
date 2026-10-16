// @vitest-environment jsdom

import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import { act, createRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";

vi.mock("./chat/AssistantCitationSource", () => ({
  observeAssistantCitationCommentSource: () => () => {},
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("./ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ "aria-label": label }: { "aria-label": string }) => (
    <button aria-label={label} />
  ),
  PopoverPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverClose: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

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

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

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
  const drafts = () => container.querySelector("output")?.dataset;

  await act(async () => root.render(<Composer question={false} editorRef={editorRef} />));
  await act(async () =>
    editorRef.current?.requestCitationComment({
      previousValue: "See ",
      value: promptBefore,
      citationStart: "See ".length,
      sourceAnchor: {} as AssistantCitationSourceAnchor,
      insertedSpaces: { before: false, after: true },
    }),
  );
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Comment editor did not open");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(textarea, "check this");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await act(async () => root.render(<Composer question editorRef={editorRef} />));
  expect(drafts()?.answer).toBe("");
  await act(async () => root.render(<Composer question={false} editorRef={editorRef} />));

  expect(drafts()?.prompt).toBe(
    `See ${serializeAssistantCitation(withAssistantCitationComment(citation, "check this"))} `,
  );
  expect(container.querySelector('[aria-label="Edit citation comment"]')).not.toBeNull();
});
