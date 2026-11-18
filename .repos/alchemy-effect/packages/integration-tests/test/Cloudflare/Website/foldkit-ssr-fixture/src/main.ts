import { Match as M, Schema as S } from "effect";
import type { Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

// MODEL

export const Model = S.Struct({ count: S.Number });
export type Model = typeof Model.Type;

// FLAGS — what the server read from the request, handed back to the
// browser so hydration rebuilds the same first Model.

export const Flags = S.Struct({ initialCount: S.Number });
export type Flags = typeof Flags.Type;

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

export const init = (flags: Flags): Update.Return<Model, Message> => ({
  model: { count: flags.initialCount },
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
