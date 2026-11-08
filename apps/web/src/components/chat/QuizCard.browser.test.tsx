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
    // The virtualized timeline remounts a card scrolled out of view.
    await screen.rerender(
      <QuizCardTimelineCard
        key="remounted"
        quizCard={{ question: "Explain this." }}
        seed="open-1"
        answered={false}
        onSendMessage={onSendMessage}
      />,
    );
    await expect
      .element(screen.getByRole("textbox", { name: "Explain your thinking" }))
      .toHaveValue("Because it follows.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSendMessage).toHaveBeenCalledWith("Because it follows.\n\n(card open-1)");

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
    expect(skip).toHaveBeenCalledWith("I don't know.\n\n(card open-2)");
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

  it("answers and grades a fill-in card", async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    await using screen = await render(
      <QuizCardTimelineCard
        quizCard={{
          question: "The unit is ___ and the symbol is ___.",
          blanks: [{ answers: ["meter"] }, { answers: ["m"] }],
        }}
        seed="blanks-1"
        answered={false}
        onSendMessage={onSendMessage}
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Blank 1" }).element());
    await userEvent.type(screen.getByRole("textbox", { name: "Blank 1" }), "meter");
    await userEvent.type(screen.getByRole("textbox", { name: "Blank 2" }), "x");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSendMessage).toHaveBeenCalledWith(
      'Blanks answer: 1. "meter", right; 2. "x", wrong.\n\n(card blanks-1)',
    );
    expect(screen.getByText("Blank 1: Right. Accepted: meter")).toBeVisible();
    expect(screen.getByText("Blank 2: Wrong. Accepted: m")).toBeVisible();
  });

  it("sends a number answer with its unit", async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    await using screen = await render(
      <QuizCardTimelineCard
        quizCard={{
          question: "What is the speed?",
          number: { answer: 9.8, tolerance: 0.1, unit: "m/s" },
        }}
        seed="number-1"
        answered={false}
        onSendMessage={onSendMessage}
      />,
    );
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Your answer" }), "9.8");
    expect(send).not.toBeDisabled();
    await userEvent.click(send);
    expect(onSendMessage).toHaveBeenCalledWith(
      'Number answer: "9.8 m/s", right.\n\n(card number-1)',
    );
  });
});
