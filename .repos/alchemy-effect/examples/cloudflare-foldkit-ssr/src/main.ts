import { Button } from "@foldkit/ui";
import { Effect, Schema } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import { type Document, type HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import { COUNT_COOKIE } from "./cookie";

// MODEL

export const Model = Schema.Struct({
  count: Schema.Number,
  renderedAt: Schema.String,
  renderedOn: Schema.Literals(["Server", "Client"]),
});
export type Model = typeof Model.Type;

// FLAGS

export const Flags = Schema.Struct({
  initialCount: Schema.Number,
  renderedAt: Schema.String,
  renderedOn: Schema.Literals(["Server", "Client"]),
});
export type Flags = typeof Flags.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedDecrement: {},
  ClickedIncrement: {},
  CompletedPersistCount: {},
});

export type Message = typeof Message.Type;

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedDecrement: () => {
      const nextCount = model.count - 1;
      return {
        model: modifyFields(model, { count: () => nextCount }),
        commands: [PersistCount({ count: nextCount })],
      };
    },
    ClickedIncrement: () => {
      const nextCount = model.count + 1;
      return {
        model: modifyFields(model, { count: () => nextCount }),
        commands: [PersistCount({ count: nextCount })],
      };
    },
    CompletedPersistCount: () => ({ model }),
  });

// COMMAND

const COUNT_COOKIE_MAX_AGE_SECONDS = 31536000;

export const PersistCount = Command.define("PersistCount", {
  args: { count: Schema.Number },
  messages: [Message.CompletedPersistCount],
  execute: ({ count }) =>
    Effect.try(() => {
      document.cookie = `${COUNT_COOKIE}=${count}; path=/; max-age=${COUNT_COOKIE_MAX_AGE_SECONDS}`;
    }).pipe(
      Effect.map(() => Message.CompletedPersistCount()),
      Effect.catch(() => Effect.succeed(Message.CompletedPersistCount())),
    ),
});

// INIT

export const init: Runtime.ApplicationInit<Model, Message, Flags> = (flags) => ({
  model: {
    count: flags.initialCount,
    renderedAt: flags.renderedAt,
    renderedOn: flags.renderedOn,
  },
});

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `Count ${model.count}`,
  body: h.div(
    [h.Class("min-h-screen bg-white flex flex-col items-center justify-center gap-6 p-6")],
    [
      h.h1([h.Class("text-2xl font-semibold text-gray-800")], ["Server-rendered counter"]),
      h.p([h.Id("count"), h.Class("text-6xl font-bold text-gray-800")], [model.count.toString()]),
      h.div(
        [h.Class("flex flex-wrap justify-center gap-4")],
        [
          Button.view(
            {
              onClick: Message.ClickedDecrement(),
              toView: (attributes) => h.button([...attributes.button, h.Class(buttonStyle)], ["-"]),
            },
            h,
          ),
          Button.view(
            {
              onClick: Message.ClickedIncrement(),
              toView: (attributes) => h.button([...attributes.button, h.Class(buttonStyle)], ["+"]),
            },
            h,
          ),
        ],
      ),
      h.p(
        [h.Id("provenance"), h.Class("text-sm text-gray-500")],
        [`Rendered on the ${model.renderedOn} at ${model.renderedAt}`],
      ),
      h.p(
        [h.Class("text-sm text-gray-500 max-w-md text-center")],
        [
          "The count persists in a cookie. Reload the page and the server " +
            "renders your latest count into the HTML before any JavaScript runs.",
        ],
      ),
    ],
  ),
});

// STYLE

const buttonStyle = "bg-black text-white hover:bg-gray-700 px-4 py-2 transition";
