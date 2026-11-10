import type { UserInputQuestion } from "@t3tools/contracts";
import type { ReactNode, Ref } from "react";
import { act, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type InputProps = {
  defaultValue: string;
  onChangeText: (text: string) => void;
  ref: Ref<{ clear: () => void }>;
};

// Models the uncontrolled native input: it keeps its own text and only `clear()` writes it.
const field = vi.hoisted(() => ({ props: null as InputProps | null, text: "" }));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppTextInput: (props: InputProps) => {
    field.props = props;
    useState(() => {
      field.text = props.defaultValue;
    });
    useImperativeHandle(props.ref, () => ({
      clear: () => {
        field.text = "";
      },
    }));
    return null;
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
  if (!field.props) throw new Error("answer field not rendered");
  return field.props;
}

function type(text: string) {
  field.text = text;
  act(() => input().onChangeText(text));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  field.props = null;
  field.text = "";
});

afterEach(() => {
  act(() => root.unmount());
});

describe("QuestionAttachments answer field", () => {
  it("clears native text on option selection before the empty draft changes", () => {
    render("");
    type("new answer");

    render("", 1);
    expect(field.text).toBe("");

    type("a");
    type("");
    type("ab");
    render("", 2);
    expect(field.text).toBe("");
  });
});
