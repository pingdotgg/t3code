import { Match as M, Schema as S } from "effect";
import type { Runtime, Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

// MODEL

export const Model = S.Struct({ count: S.Number });
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedDecrement: {},
  ClickedIncrement: {},
  ClickedReset: {},
});
export const { ClickedDecrement, ClickedIncrement, ClickedReset } = Message;
export type Message = typeof Message.Type;

// UPDATE

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

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { count: 0 },
});

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
