import { Schema, pipe } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion, literal } from "foldkit/route";

export const AppRoute = defineRouteUnion({
  Home: {},
  About: {},
  NotFound: { path: Schema.String },
});

export type AppRoute = typeof AppRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home));
export const aboutRouter = pipe(literal("about"), Route.mapTo(AppRoute.About));

export const prerenderPaths: ReadonlyArray<string> = [homeRouter(), aboutRouter()];

const routeParser = Route.oneOf(aboutRouter, homeRouter);

export const urlToAppRoute = Route.parseUrlWithFallback(routeParser, AppRoute.NotFound);
