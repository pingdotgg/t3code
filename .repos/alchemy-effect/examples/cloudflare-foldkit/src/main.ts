import { Match as M, Schema as S } from "effect";
import { Command, Runtime } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { m } from "foldkit/message";

// MODEL

export const Model = S.Struct({ count: S.Number });
export type Model = typeof Model.Type;

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

export const init: Runtime.ApplicationInit<Model, Message> = () => [
  { count: 0 },
  [],
];

// VIEW

const buttonClass =
  "rounded-lg bg-slate-800 px-4 py-2 font-semibold text-white hover:bg-slate-700";

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `Counter: ${model.count}`,
  body: h.div(
    [
      h.Id("app"),
      h.Class(
        "flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-100",
      ),
    ],
    [
      h.p(
        [h.Id("count"), h.Class("text-3xl font-bold text-slate-900")],
        [model.count.toString()],
      ),
      h.div(
        [h.Class("flex gap-3")],
        [
          h.button(
            [h.OnClick(ClickedDecrement()), h.Class(buttonClass)],
            ["-"],
          ),
          h.button(
            [h.OnClick(ClickedReset()), h.Class(buttonClass)],
            ["Reset"],
          ),
          h.button(
            [h.OnClick(ClickedIncrement()), h.Class(buttonClass)],
            ["+"],
          ),
        ],
      ),
    ],
  ),
});
