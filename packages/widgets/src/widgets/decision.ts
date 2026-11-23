import { button, callTool, card, failure, h, start, t } from "../runtime.ts";

interface Ask {
  readonly id: string;
  readonly question: string;
}

void start<{
  readonly workstreamId: string;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
}>((decision, root) => {
  const draw = (ask: Ask | undefined) => {
    const content =
      ask === undefined
        ? h("span", { class: "soft" }, t("Answered", "Odpowiedziano"))
        : h(
            "div",
            { class: "row" },
            ...decision.options.map((option, at) =>
              button(
                option,
                () =>
                  void callTool("decision_answer", { id: ask.id, answer: option }).then(
                    () => draw(undefined),
                    (error: unknown) => root.append(failure(error)),
                  ),
                at === 0 ? "primary" : "plain",
              ),
            ),
          );
    root.replaceChildren(card(decision.question, [content], { fullscreen: false }));
  };
  callTool("project_asks", { id: decision.workstreamId }).then(
    ({ decisions }) =>
      draw(
        (decisions as ReadonlyArray<Ask>).findLast(
          ({ question }) => question === decision.question,
        ),
      ),
    (error: unknown) => root.replaceChildren(failure(error)),
  );
});
