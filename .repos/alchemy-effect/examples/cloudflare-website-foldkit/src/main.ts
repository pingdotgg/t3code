import { Schema as S } from "effect";
import type { Command, Runtime } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";

import { card } from "./components/Card.ts";

// MODEL

export const Model = S.Struct({});
export type Model = typeof Model.Type;

// MESSAGE

// The page is static — nothing dispatches, so the app has no messages.
export type Message = never;

// UPDATE

export const update = (
  model: Model,
  _message: Message,
): readonly [Model, ReadonlyArray<Command.Command<Message>>] => [model, []];

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => [{}, []];

// VIEW

export const view = (_model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Foldkit",
  body: h.div(
    [h.Id("app")],
    [
      h.h1([h.Class("text-3xl font-bold")], ["Hello from Foldkit!"]),
      card(h, {
        title: "Styled with Tailwind CSS",
        body: "This card is a Foldkit view function styled with Tailwind utilities.",
      }),
    ],
  ),
});
