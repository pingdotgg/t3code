import { Match as M, Schema as S } from "effect";
import type { Runtime, Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { card } from "./components/Card.ts";

export const Model = S.Struct({ count: S.Number });
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  ClickedDecrement: {},
  ClickedIncrement: {},
  ClickedReset: {},
});
export const { ClickedDecrement, ClickedIncrement, ClickedReset } = Message;
export type Message = typeof Message.Type;

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  M.value(message).pipe(
    M.withReturnType<Update.Return<Model, Message>>(),
    M.tagsExhaustive({
      ClickedDecrement: () => ({ model: { count: model.count - 1 } }),
      ClickedIncrement: () => ({ model: { count: model.count + 1 } }),
      ClickedReset: () => ({ model: { count: 0 } }),
    }),
  );

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { count: 0 },
});

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Foldkit on Prisma",
  body: h.div(
    [h.Id("app")],
    [
      h.h1([h.Class("text-3xl font-bold")], ["Foldkit on Prisma"]),
      card(h, {
        title: "A model/update/view counter",
        body: "The Foldkit runtime renders each state transition in the browser.",
      }),
      h.p([h.Id("count")], [String(model.count)]),
      h.button([h.OnClick(ClickedDecrement())], ["-"]),
      h.button([h.OnClick(ClickedReset())], ["Reset"]),
      h.button([h.OnClick(ClickedIncrement())], ["+"]),
      h.a([h.Href("/example.json")], ["Static JSON asset"]),
    ],
  ),
});
