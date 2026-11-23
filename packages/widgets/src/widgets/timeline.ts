import { card, h, start, t } from "../runtime.ts";

void start<{
  readonly title: string;
  readonly events: ReadonlyArray<{
    readonly date: string;
    readonly title: string;
    readonly description?: string;
  }>;
}>((timeline, root) => {
  root.append(
    card(
      timeline.title,
      [
        h(
          "ol",
          { class: "timeline" },
          ...timeline.events.map(({ date, title, description }) =>
            h(
              "li",
              {},
              h("time", {}, date),
              h("div", {}, h("b", {}, title)),
              description === undefined ? null : h("p", {}, description),
            ),
          ),
        ),
      ],
      { ask: `${t("About the timeline", "O osi czasu")} "${timeline.title}": ` },
    ),
  );
});
