import { Schema, pipe } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion, literal } from "foldkit/route";

export const AppRoute = defineRouteUnion({
  Home: {},
  About: {},
  Counter: {},
  NotFound: { path: Schema.String },
});

export type AppRoute = typeof AppRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home));
export const aboutRouter = pipe(literal("about"), Route.mapTo(AppRoute.About));

export const counterRouter = pipe(literal("counter"), Route.mapTo(AppRoute.Counter));

export const prerenderPaths: ReadonlyArray<string> = [homeRouter(), aboutRouter()];

const routeParser = Route.oneOf(counterRouter, aboutRouter, homeRouter);

export const urlToAppRoute = Route.parseUrlWithFallback(routeParser, AppRoute.NotFound);
