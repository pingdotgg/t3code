import type { UserInputQuestion } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type InputProps = { value: string; onChangeText: (text: string) => void };

const field = vi.hoisted(() => ({ props: null as InputProps | null }));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppTextInput: (props: InputProps) => {
    field.props = props;
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
  act(() => input().onChangeText(text));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  field.props = null;
});

afterEach(() => {
  act(() => root.unmount());
});

describe("QuestionAttachments answer field", () => {
  it("keeps newer typing when the thread screen echoes an older draft", () => {
    render("de");
    type("de ");
    type("de s");

    render("de ");
    expect(input().value).toBe("de s");

    render("de s");
    expect(input().value).toBe("de s");
  });

  it("keeps a 注音 composition when a late echo arrives mid-composition", () => {
    render("");
    type("ㄋ");
    type("ㄋㄧ");
    type("ㄋㄧˇ");

    render("ㄋㄧ");
    expect(input().value).toBe("ㄋㄧˇ");

    // Picking a candidate replaces the composed symbols with the character.
    type("你");
    render("你");
    expect(input().value).toBe("你");

    render("ㄋㄧ");
    expect(input().value).toBe("你");
  });

  it("adopts a draft changed from outside the field", () => {
    render("");
    type("my own colour");
    render("my own colour");

    render("", 1);
    expect(input().value).toBe("");
  });

  it("adopts an outside change while its own echoes are still pending", () => {
    render("");
    type("a");
    type("ab");

    render("a");
    render("", 1);
    expect(input().value).toBe("");

    type("new answer");
    render("", 2);
    expect(input().value).toBe("");

    type("a");
    type("");
    type("ab");
    render("", 3);
    expect(input().value).toBe("");
  });
});
