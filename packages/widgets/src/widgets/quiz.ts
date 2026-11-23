import { button, callTool, card, failure, h, start, t } from "../runtime.ts";

interface Question {
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly answer: number;
  readonly hint?: string;
  readonly explanation?: string;
}

void start<{ readonly title: string; readonly questions: ReadonlyArray<Question> }>(
  (quiz, root) => {
    const picks: Array<number | undefined> = quiz.questions.map(() => undefined);
    let index = 0;
    let hinted = false;

    const correct = () => picks.filter((pick, at) => pick === quiz.questions[at]!.answer).length;

    const finish = () => {
      const missed = quiz.questions.filter((question, at) => picks[at] !== question.answer);
      const status = h("p", { class: "soft" });
      const save = async () => {
        try {
          await callTool("quiz_to_flashcards", {
            title: quiz.title,
            cards: missed.map(({ question, options, answer, explanation }) => ({
              front: question,
              back: [options[answer], explanation].filter(Boolean).join("\n"),
            })),
          });
          status.textContent = t("Saved in Study.", "Zapisano w Nauce.");
        } catch (error) {
          status.replaceWith(failure(error));
        }
      };
      void callTool("quiz_record", {
        title: quiz.title,
        correct: correct(),
        total: quiz.questions.length,
      }).catch(() => {});
      root.replaceChildren(
        card(
          quiz.title,
          [
            h("h1", { style: "font-size:24px" }, `${correct()} / ${quiz.questions.length}`),
            h(
              "div",
              { class: "stack" },
              ...missed.map(({ question, options, answer }) =>
                h("div", { class: "note" }, h("b", {}, question), h("div", {}, options[answer]!)),
              ),
            ),
            h(
              "div",
              { class: "row", style: "margin-top:12px" },
              missed.length > 0 &&
                button(
                  t("Make flashcards from mistakes", "Zrób fiszki z błędów"),
                  () => void save(),
                  "primary",
                ),
              button(t("Try again", "Jeszcze raz"), () => {
                picks.fill(undefined);
                index = 0;
                draw();
              }),
            ),
            status,
          ],
          {
            ask: `${t("Quiz", "Quiz")} "${quiz.title}": ${correct()}/${quiz.questions.length}. ${t("I got these wrong", "Nie wiedziałem")}: ${missed.map(({ question }) => question).join("; ")}`,
          },
        ),
      );
    };

    const draw = () => {
      const question = quiz.questions[index]!;
      const pick = picks[index];
      const answered = pick !== undefined;
      root.replaceChildren(
        card(
          quiz.title,
          [
            h(
              "div",
              { class: "progress", style: "margin-bottom:14px" },
              h("i", { style: `width:${((index + 1) / quiz.questions.length) * 100}%` }),
            ),
            h("p", { style: "font-weight:600;margin:0 0 10px" }, question.question),
            h(
              "div",
              { class: "stack" },
              ...question.options.map((option, at) => {
                const choice = button(option, () => {
                  picks[index] = at;
                  draw();
                });
                choice.classList.add("option");
                choice.disabled = answered;
                if (answered && at === question.answer) choice.classList.add("right");
                if (answered && at === pick && at !== question.answer) {
                  choice.classList.add("wrong");
                }
                return choice;
              }),
            ),
            !answered &&
              question.hint !== undefined &&
              (hinted
                ? h("p", { class: "note" }, question.hint)
                : button(
                    t("Hint", "Podpowiedź"),
                    () => {
                      hinted = true;
                      draw();
                    },
                    "ghost",
                  )),
            answered &&
              h(
                "p",
                { class: "note" },
                h(
                  "b",
                  {},
                  pick === question.answer
                    ? t("Correct. ", "Dobrze. ")
                    : t("Not quite. ", "Niezupełnie. "),
                ),
                question.explanation ?? "",
              ),
            answered &&
              h(
                "div",
                { class: "row", style: "margin-top:12px" },
                button(
                  index + 1 === quiz.questions.length ? t("Result", "Wynik") : t("Next", "Dalej"),
                  () => {
                    hinted = false;
                    index += 1;
                    if (index === quiz.questions.length) finish();
                    else draw();
                  },
                  "primary",
                ),
              ),
          ],
          {
            ask: `${t("About this quiz question", "Pytanie z quizu")}: ${question.question}`,
            meta: `${index + 1} / ${quiz.questions.length}`,
          },
        ),
      );
    };
    draw();
  },
);
