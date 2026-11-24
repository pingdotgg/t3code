import { button, callTool, card, failure, h, openStudy, start, t } from "../runtime.ts";

interface Flashcard {
  readonly id: string;
  readonly front: string;
  readonly back: string;
  readonly hint: string | null;
  readonly reviewCount: number;
}

void start<{ readonly deckId: string; readonly title: string }>((deck, root) => {
  let cards: ReadonlyArray<Flashcard> = [];
  let index = 0;
  let flipped = false;
  let editing = false;
  let rating = false;

  const show = (next: number) => {
    index = (next + cards.length) % cards.length;
    flipped = false;
    editing = false;
    draw();
  };

  const replace = (saved: Flashcard) => {
    cards = cards.map((entry) => (entry.id === saved.id ? saved : entry));
  };

  const rate = async (grade: string) => {
    if (rating) return;
    rating = true;
    const { id, reviewCount } = cards[index]!;
    try {
      const reviewed = await callTool("flashcards_review", { id, rating: grade, reviewCount });
      replace(reviewed.card as Flashcard);
      show(index + 1);
    } catch (error) {
      root.append(failure(error));
    } finally {
      rating = false;
    }
  };

  const editor = (current: Flashcard) => {
    const front = h("textarea", { value: current.front, rows: 2 });
    const back = h("textarea", { value: current.back, rows: 3 });
    const save = async () => {
      try {
        const { card: saved } = await callTool("flashcards_edit", {
          id: current.id,
          front: front.value,
          back: back.value,
          hint: current.hint,
        });
        replace(saved as Flashcard);
        editing = false;
        draw();
      } catch (error) {
        root.append(failure(error));
      }
    };
    return h(
      "div",
      { class: "stack" },
      front,
      back,
      h(
        "div",
        { class: "row" },
        button(t("Save", "Zapisz"), () => void save(), "primary"),
        button(t("Cancel", "Anuluj"), () => {
          editing = false;
          draw();
        }),
      ),
    );
  };

  const draw = () => {
    const current = cards[index];
    if (current === undefined) {
      root.replaceChildren(card(deck.title, [t("This deck is empty.", "Ta talia jest pusta.")]));
      return;
    }
    const flip = () => {
      flipped = !flipped;
      draw();
    };
    const face = h(
      "button",
      { type: "button", class: "face", onclick: flip },
      h("small", {}, flipped ? t("Answer", "Odpowiedź") : t("Question", "Pytanie")),
      h("b", {}, flipped ? current.back : current.front),
      !flipped && current.hint !== null && h("span", { class: "soft" }, current.hint),
    );
    const controls = flipped
      ? h(
          "div",
          { class: "row" },
          button(t("Again", "Znowu"), () => void rate("again")),
          button(t("Hard", "Trudne"), () => void rate("hard")),
          button(t("Good", "Dobrze"), () => void rate("good"), "primary"),
          button(t("Easy", "Łatwe"), () => void rate("easy")),
        )
      : h(
          "div",
          { class: "row" },
          button(t("Show answer", "Pokaż odpowiedź"), flip),
          button(t("Study now", "Ucz się teraz"), () => openStudy(deck.deckId), "primary"),
        );
    root.replaceChildren(
      card(
        deck.title,
        editing
          ? [editor(current)]
          : [
              face,
              h(
                "div",
                { class: "row spread" },
                controls,
                h(
                  "div",
                  { class: "row" },
                  button(
                    t("Edit", "Edytuj"),
                    () => {
                      editing = true;
                      draw();
                    },
                    "ghost",
                  ),
                  button("‹", () => show(index - 1)),
                  button("›", () => show(index + 1)),
                ),
              ),
            ],
        {
          ask: `${t("Explain this flashcard", "Wyjaśnij tę fiszkę")}: ${current.front} (${current.back})`,
          meta: `${index + 1} / ${cards.length}`,
        },
      ),
    );
  };

  window.addEventListener("keydown", (event) => {
    if (editing || cards.length === 0) return;
    if (event.key === "ArrowRight") show(index + 1);
    else if (event.key === "ArrowLeft") show(index - 1);
  });

  callTool("flashcards_cards", { id: deck.deckId }).then(
    (result) => {
      cards = result.cards as ReadonlyArray<Flashcard>;
      draw();
    },
    (error: unknown) => root.replaceChildren(card(deck.title, [failure(error)])),
  );
});
