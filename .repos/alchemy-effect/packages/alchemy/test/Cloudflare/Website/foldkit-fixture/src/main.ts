import { Match as M, Schema as S } from "effect";
import { Command, Runtime } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { m } from "foldkit/message";

// MODEL

export const Model = S.Struct({ count: S.Number });
export type Model = typeof Model.Type;

// MESSAGE

export const ClickedIncrement = m("ClickedIncrement");
export const Message = S.Union([ClickedIncrement]);
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
      ClickedIncrement: () => [{ count: model.count + 1 }, []],
    }),
  );

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => [
  { count: 0 },
  [],
];

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `Counter: ${model.count}`,
  body: h.div(
    [h.Id("app")],
    [
      h.p([h.Id("count")], [model.count.toString()]),
      h.button([h.Id("increment"), h.OnClick(ClickedIncrement())], ["+"]),
    ],
  ),
});
