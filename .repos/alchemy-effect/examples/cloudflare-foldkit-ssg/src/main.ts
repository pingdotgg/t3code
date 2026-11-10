import { Effect, Schema, pipe } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import { type Document, type Html, type HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import { Url, toString as urlToString } from "foldkit/url";
import { AppRoute, aboutRouter, homeRouter, urlToAppRoute } from "./route";

// MODEL

export const Model = Schema.Struct({
  route: AppRoute,
  count: Schema.Number,
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedIncrement: {},
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
});

export type Message = typeof Message.Type;

// INIT

export const init: Runtime.RoutingApplicationInit<Model, Message> = (url) => ({
  model: { route: urlToAppRoute(url), count: 0 },
});

// COMMAND

const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
});

const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
});

// UPDATE

type UpdateReturn = Update.Return<Model, Message>;

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedIncrement: () => ({
      model: modifyFields(model, { count: (count) => count + 1 }),
    }),
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [NavigateInternal({ url: urlToString(url) })],
        }),
        External: ({ href }) => ({
          model,
          commands: [LoadExternal({ href })],
        }),
      }),
    ChangedUrl: ({ url }) => ({
      model: modifyFields(model, { route: () => urlToAppRoute(url) }),
    }),
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
  });

// VIEW

const APP_NAME = "Foldkit App";

const appendAppName = (page: string): string => `${page} | ${APP_NAME}`;

const routeTitle = (route: AppRoute): string =>
  pipe(
    AppRoute.match(route, {
      Home: () => "Home",
      About: () => "About",
      NotFound: () => "Not Found",
    }),
    appendAppName,
  );

const navigationView = (h: HtmlBuilder<Message>): Html =>
  h.nav(
    [h.Class("flex gap-4")],
    [
      h.a([h.Href(homeRouter()), h.Class("underline")], ["Home"]),
      h.a([h.Href(aboutRouter()), h.Class("underline")], ["About"]),
    ],
  );

const pageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  AppRoute.match(model.route, {
    Home: () =>
      h.section(
        [h.Class("grid gap-4")],
        [
          h.h1([h.Id("page-title"), h.Class("text-4xl font-bold")], ["Statically generated home"]),
          h.p([], ["This route was rendered during the build and hydrated in place."]),
          h.button(
            [h.OnClick(Message.ClickedIncrement()), h.Class("w-fit bg-black px-4 py-2 text-white")],
            [`Count: ${model.count}`],
          ),
        ],
      ),
    About: () =>
      h.section(
        [h.Class("grid gap-4")],
        [
          h.h1(
            [h.Id("page-title"), h.Class("text-4xl font-bold")],
            ["Statically generated about page"],
          ),
          h.p([], ["The same renderPage function produced this route in the same build."]),
        ],
      ),
    NotFound: ({ path }) =>
      h.section(
        [h.Class("grid gap-4")],
        [
          h.h1([h.Id("page-title"), h.Class("text-4xl font-bold")], ["Not found"]),
          h.p([], [`No statically generated page exists for ${path}.`]),
        ],
      ),
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: routeTitle(model.route),
  body: h.main(
    [h.Class("mx-auto grid min-h-screen max-w-3xl content-center gap-10 p-8")],
    [navigationView(h), pageView(model, h)],
  ),
});
