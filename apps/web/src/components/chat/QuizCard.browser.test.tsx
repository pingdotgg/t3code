import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { QuizCardTimelineCard } from "./QuizCard";

const quiz = {
  answer: "A",
  explanation: "Because",
  level: "apply" as const,
  question: "Which?",
  wrongOptions: [
    { option: "B", wrongIdea: "Mistake" },
    { option: "C", wrongIdea: "Another" },
  ],
};

describe("QuizCardTimelineCard", () => {
  it("focuses and sends an open answer, including the skip answer", async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    await using screen = await render(
      <QuizCardTimelineCard
        quizCard={{ question: "Explain this." }}
        seed="open-1"
        answered={false}
        onSendMessage={onSendMessage}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "Explain your thinking" });
    expect(document.activeElement).toBe(textarea.element());
    await userEvent.type(textarea, "Because it follows.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSendMessage).toHaveBeenCalledWith("Because it follows.");

    const skip = vi.fn().mockResolvedValue(undefined);
    await using skipScreen = await render(
      <QuizCardTimelineCard
        quizCard={{ question: "Explain this." }}
        seed="open-2"
        answered={false}
        onSendMessage={skip}
      />,
    );
    await userEvent.click(skipScreen.getByRole("button", { name: "I don't know" }));
    expect(skip).toHaveBeenCalledWith("I don't know.");
  });

  it("requires thinking after a multiple-choice pick", async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    await using screen = await render(
      <QuizCardTimelineCard
        quizCard={quiz}
        seed="mc-1"
        answered={false}
        onSendMessage={onSendMessage}
      />,
    );
    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByText("A", { exact: true }));
    expect(submit).toBeDisabled();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Explain your thinking" }),
      "It matches.",
    );
    expect(submit).not.toBeDisabled();
  });
});
