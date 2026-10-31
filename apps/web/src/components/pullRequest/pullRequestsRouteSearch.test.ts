import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

// Importing the route also imports the diff viewer; its browser worker is unused by search.
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({ default: vi.fn() }));

import { Route as PullRequestsRoute } from "../../routes/_chat.pull-requests";

function matchedSearch(url: string) {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const pullRequests = createRoute({
    getParentRoute: () => chat,
    path: "pull-requests",
    validateSearch: PullRequestsRoute.options.validateSearch,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([pullRequests])]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  // useSearch reads matched-route search, which can differ from URL search.
  return router.matchRoutes(router.latestLocation).at(-1)?.search as
    | Record<string, unknown>
    | undefined;
}

describe("pull requests route search", () => {
  it("keeps a q the URL parser turned into a number or boolean as text", () => {
    expect(matchedSearch("/pull-requests?q=4089")?.q).toBe("4089");
    expect(matchedSearch("/pull-requests?q=true")?.q).toBe("true");
  });

  it("keeps a q that is text, including quoted digits", () => {
    expect(matchedSearch("/pull-requests?q=fix")?.q).toBe("fix");
    expect(matchedSearch("/pull-requests?q=%224089%22")?.q).toBe("4089");
    expect(matchedSearch("/pull-requests?q=")?.q).toBeUndefined();
    expect(matchedSearch("/pull-requests?q=null")?.q).toBeUndefined();
  });
});
