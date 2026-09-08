import { Match as M, Schema as S } from "effect";
import { Command } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { m } from "foldkit/message";

// MODEL

export const Model = S.Struct({ count: S.Number });
export type Model = typeof Model.Type;

// FLAGS
//
// What the server knew when it rendered, and what the browser is handed back
// so it can rebuild the same first Model. The server reads it from the
// request; hydration decodes it from the page rather than guessing. Flags
// ship in the HTML, so they are public — never put a secret here.

export const Flags = S.Struct({ initialCount: S.Number });
export type Flags = typeof Flags.Type;

// MESSAGE

export const ClickedDecrement = m("ClickedDecrement");
export const ClickedIncrement = m("ClickedIncrement");
export const ClickedReset = m("ClickedReset");

export const Message = S.Union([
  ClickedDecrement,
  ClickedIncrement,
  ClickedReset,
]);
export type Message = typeof Message.Type;

// UPDATE

export const update = (
  model: Model,
  message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] =>
  M.value(message).pipe(
    M.withReturnType<
      readonly [Model, ReadonlyArray<Command.Command<Message>>]
    >(),
    M.tagsExhaustive({
      ClickedDecrement: () => [{ count: model.count - 1 }, []],
      ClickedIncrement: () => [{ count: model.count + 1 }, []],
      ClickedReset: () => [{ count: 0 }, []],
    }),
  );

// INIT
//
// Runs on the server to produce the rendered Model, then again in the browser
// with the same Flags. Both sides must reach the same Model or hydration
// rebuilds the tree it was supposed to adopt.

export const init = (
  flags: Flags,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] => [
  { count: flags.initialCount },
  [],
];

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `Counter: ${model.count}`,
  body: h.div(
    [h.Id("app")],
    [
      h.p([h.Id("count")], [model.count.toString()]),
      h.div(
        [],
        [
          h.button([h.OnClick(ClickedDecrement())], ["-"]),
          h.button([h.OnClick(ClickedReset())], ["Reset"]),
          h.button([h.OnClick(ClickedIncrement())], ["+"]),
        ],
      ),
    ],
  ),
});
