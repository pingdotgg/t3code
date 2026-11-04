import { Match as M, Schema as S } from "effect";
import type { Runtime, Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

// Proves the module served/bundled is this source (the dev server serves it
// verbatim; the built bundle inlines it).
export const marker = "FOLDKIT_AWS_MODULE_MARKER";

// MODEL

export const Model = S.Struct({ count: S.Number });
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedIncrement: {},
});
export const { ClickedIncrement } = Message;
export type Message = typeof Message.Type;

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  M.value(message).pipe(
    M.withReturnType<Update.Return<Model, Message>>(),
    M.tagsExhaustive({
      ClickedIncrement: () => ({ model: { count: model.count + 1 } }),
    }),
  );

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { count: 0 },
});

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
