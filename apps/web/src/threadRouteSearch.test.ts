import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { stripDiffSearchParams, threadDiffRouteSearchOptions } from "./diffRouteSearch";

describe("thread route diff search state", () => {
  it("allows removing diff params from the active thread route", async () => {
    const threadId = "thread-route-search-test";
    const rootRoute = createRootRoute();
    const threadRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "$threadId",
      ...threadDiffRouteSearchOptions,
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([threadRoute]),
      history: createMemoryHistory({
        initialEntries: [`/${threadId}?diff=1&diffTurnId=turn-1&diffFilePath=src/app.ts`],
      }),
    });

    await router.load();
    await router.navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => stripDiffSearchParams(previous),
    });

    expect(router.state.location.search).toEqual({});
    expect(router.state.location.href).toBe(`/${threadId}`);
  });
});
