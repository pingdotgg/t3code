import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), () => ({
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { render } from "../../../test/render";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

type Question = {
  header: string;
  question: string;
  options: { label: string; description: string }[];
};

const renderPanel = (questions: Question[], questionIndex = 0) =>
  render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[
        {
          requestId: RuntimeRequestId.make("question-direction"),
          createdAt: "2026-10-23T00:00:00.000Z",
          dismissible: false,
          responseCapability: "live",
          questions: questions.map((question, index) => ({
            ...question,
            id: `question-${index}`,
            multiSelect: false,
          })),
        },
      ]}
      cwd={undefined}
      threadRef={{ environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") }}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={questionIndex}
      onToggleOption={() => {}}
      onAdvance={() => {}}
      onDismiss={() => {}}
    />,
  );

it("reads a mostly Hebrew question set right to left", async () => {
  await using screen = await renderPanel([
    {
      header: "גישה",
      question: "איך לבצע את המיגרציה?",
      options: [
        {
          label: "React Server Components בכל המסכים של האפליקציה",
          description: "מסך אחד בכל פעם",
        },
        { label: "Keep it on React 18", description: "English only" },
      ],
    },
  ]);

  const text = (value: string) => screen.getByText(value, { exact: true });
  await expect.element(text("גישה")).toHaveStyle({ direction: "rtl" });
  await expect
    .element(text("React Server Components בכל המסכים של האפליקציה"))
    .toHaveStyle({ direction: "rtl" });
  await expect.element(text("מסך אחד בכל פעם")).toHaveStyle({ direction: "rtl" });
  await expect
    .element(screen.getByRole("button", { name: /React Server/ }))
    .toHaveStyle({ direction: "rtl" });
  await expect.element(text("Keep it on React 18")).toHaveStyle({ direction: "ltr" });

  await screen.getByTitle("Hide the question and its options").click();
  await expect.element(text("איך לבצע את המיגרציה?")).toHaveStyle({ direction: "rtl" });
});

it("keeps one direction for the whole set when a single question is Hebrew", async () => {
  await using screen = await renderPanel(
    [
      {
        header: "Migration",
        question: "How should we move to React Server Components?",
        options: [
          { label: "Screen by screen", description: "Lower risk, each step tested alone." },
          { label: "Server Actions for all forms first", description: "Then the rest." },
        ],
      },
      {
        header: "גרסה",
        question: "בחר גרסה",
        options: [{ label: "גרסה 3 (חדשה!)", description: "!!!" }],
      },
    ],
    1,
  );

  await expect
    .element(screen.getByRole("button", { name: /גרסה 3/ }))
    .toHaveStyle({ direction: "ltr" });
  await expect
    .element(screen.getByText("גרסה 3 (חדשה!)", { exact: true }))
    .toHaveStyle({ direction: "rtl" });
});
