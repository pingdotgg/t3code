import type { UserInputQuestion } from "@t3tools/contracts";
import type { ReactNode, Ref } from "react";
import { act, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type InputProps = {
  defaultValue: string;
  onChangeText: (text: string) => void;
  ref: Ref<{ clear: () => void }>;
};

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppTextInput: (props: InputProps) => {
    const input = useRef<HTMLInputElement>(null);
    useImperativeHandle(props.ref, () => ({
      clear: () => {
        if (input.current) input.current.value = "";
      },
    }));
    return (
      <input
        ref={input}
        defaultValue={props.defaultValue}
        onInput={(event) => props.onChangeText(event.currentTarget.value)}
      />
    );
  },
}));
vi.mock("expo-paste-input", () => ({
  TextInputWrapper: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  settlePromise: vi.fn(),
  squashAtomCommandFailure: vi.fn(),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../lib/useNativePaste", () => ({ useNativePaste: () => vi.fn() }));
vi.mock("../../lib/composerImages", () => ({
  convertPastedImagesToAttachments: vi.fn(),
  pickComposerFiles: vi.fn(),
  pickComposerMedia: vi.fn(),
}));
vi.mock("./ComposerAttachmentButton", () => ({ ComposerAttachmentButton: () => null }));
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: () => null,
}));
vi.mock("../../components/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../components/VideoPreviewModal", () => ({ VideoPreviewModal: () => null }));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "env-1", id: "thread-1" } }),
}));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => ({}) } }));
vi.mock("../../state/use-composer-drafts", () => ({
  appendComposerDraftAttachments: vi.fn(),
  composerDraftsAtom: {},
  removeComposerDraftAttachment: vi.fn(),
  releaseUnusedComposerAttachmentFiles: vi.fn(),
}));
vi.mock("../../state/question-attachments", () => ({
  changeQuestionAttachmentPreparation: vi.fn(),
  questionAttachmentDraftKey: () => "draft-key",
  questionAttachmentPreparationAtom: {},
}));

import { QuestionAttachments } from "./QuestionAttachments";

const question: UserInputQuestion = {
  id: "colour",
  header: "Colour",
  question: "Which colour?",
  options: [{ label: "Blue", description: "Blue" }],
  multiSelect: false,
};

let root: Root;
let container: HTMLDivElement;

// `draft` is what the thread screen passes back; it can lag the input by a render.
function render(draft: string, outsideChange = 0) {
  act(() =>
    root.render(
      <QuestionAttachments
        requestId="request-1"
        question={question}
        questions={[question]}
        disabled={false}
        value={draft}
        outsideChange={outsideChange}
        onChangeText={() => {}}
      />,
    ),
  );
}

function input() {
  const field = container.querySelector("input");
  if (!field) throw new Error("answer field not rendered");
  return field;
}

function type(text: string) {
  const field = input();
  field.value = text;
  act(() => field.dispatchEvent(new Event("input", { bubbles: true })));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("QuestionAttachments answer field", () => {
  it("clears native text on option selection before the empty draft changes", () => {
    render("");
    type("new answer");

    render("", 1);
    expect(input().value).toBe("");

    type("a");
    type("");
    type("ab");
    render("", 2);
    expect(input().value).toBe("");
  });
});
