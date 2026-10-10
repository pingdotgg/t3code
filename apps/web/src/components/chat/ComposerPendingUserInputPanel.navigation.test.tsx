import { RuntimeRequestId } from "@t3tools/contracts";
import { act, useState, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";

vi.mock("../ui/collapsible", () => {
  const Children = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Collapsible: Children,
    CollapsiblePanel: Children,
    CollapsibleTrigger: Children,
  };
});

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const prompt = {
  requestId: RuntimeRequestId.make("question-navigation"),
  createdAt: "2026-10-09T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [0, 1, 2].map((index) => ({
    id: `question-${index}`,
    header: `Question ${index + 1}`,
    question: `Choose for question ${index + 1}`,
    options: [{ label: "Incremental", description: "One module at a time" }],
    multiSelect: false,
  })),
};

function Questions({ initialIndex = 0 }: { initialIndex?: number }) {
  const [questionIndex, setQuestionIndex] = useState(initialIndex);
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const advance = () => setQuestionIndex(questionIndex + 1);
  return (
    <>
      <output>{questionIndex}</output>
      <button onClick={advance}>Next</button>
      <button onClick={() => setQuestionIndex(questionIndex - 1)}>Previous</button>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[prompt]}
        disabled={false}
        respondingRequestIds={[]}
        answers={answers}
        questionIndex={questionIndex}
        onAdvance={advance}
        onToggleOption={(questionId, value) => {
          const question = prompt.questions.find((entry) => entry.id === questionId)!;
          setAnswers((existing) => ({
            ...existing,
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[questionId],
              value,
            ),
          }));
        }}
        onDismiss={() => {}}
      />
    </>
  );
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function chooseOption() {
  await act(async () => {
    renderer!.root
      .findAllByType("button")
      .find((button) =>
        button.findAllByType("span").some((span) => span.children.includes("Incremental")),
      )!
      .props.onClick();
  });
}

async function navigate(label: string) {
  await act(async () => {
    renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes(label))!
      .props.onClick();
  });
}

function activeIndex() {
  return renderer!.root.findByType("output").children.join("");
}

it("does not skip the next unanswered question after manual advance", async () => {
  await act(async () => {
    renderer = create(<Questions />);
  });
  await chooseOption();
  await navigate("Next");
  expect(activeIndex()).toBe("1");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");

  await chooseOption();
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("2");
});

it("does not undo previous-question navigation with a stale timer", async () => {
  await act(async () => {
    renderer = create(<Questions initialIndex={1} />);
  });
  await chooseOption();
  await navigate("Previous");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
});

it("still auto-advances once after the answer draft rerenders the same question", async () => {
  await act(async () => {
    renderer = create(<Questions />);
  });
  await chooseOption();
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");
});
