import { button, callTool, card, failure, h, start, t } from "../runtime.ts";

interface Suggestion {
  readonly id: string;
  readonly title: string;
  readonly task: string;
}

void start<{
  readonly workstreamId: string;
  readonly threads: ReadonlyArray<{ readonly title: string; readonly task: string }>;
}>((data, root) => {
  let waiting: ReadonlyArray<Suggestion> = [];
  const draw = () => {
    root.replaceChildren(
      card(
        t("Suggested threads", "Proponowane wątki"),
        [
          h(
            "div",
            { class: "stack" },
            ...data.threads.map(({ title, task }) => {
              const open = waiting.find((entry) => entry.title === title && entry.task === task);
              const answer = (approve: boolean) => () =>
                void callTool("suggestion_resolve", { id: open!.id, approve }).then(
                  () => {
                    waiting = waiting.filter((entry) => entry !== open);
                    draw();
                  },
                  (error: unknown) => root.append(failure(error)),
                );
              return h(
                "div",
                { class: "row spread" },
                h(
                  "div",
                  { style: "flex:1 1 220px" },
                  h("b", {}, title),
                  h("div", { class: "soft" }, task),
                ),
                open === undefined
                  ? h("span", { class: "soft" }, t("Answered", "Rozpatrzono"))
                  : h(
                      "div",
                      { class: "row" },
                      button(t("Start", "Uruchom"), answer(true), "primary"),
                      button(t("Skip", "Pomiń"), answer(false)),
                    ),
              );
            }),
          ),
        ],
        { fullscreen: false },
      ),
    );
  };
  callTool("project_asks", { id: data.workstreamId }).then(
    ({ suggestions }) => {
      waiting = suggestions as ReadonlyArray<Suggestion>;
      draw();
    },
    (error: unknown) => root.replaceChildren(failure(error)),
  );
});
