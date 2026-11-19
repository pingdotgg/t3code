import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

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
  it("drops a q the URL parser turned into a number", () => {
    expect(matchedSearch("/pull-requests?q=4089")?.q).toBeUndefined();
    expect(matchedSearch("/pull-requests?q=true")?.q).toBeUndefined();
  });

  it("keeps a q that is text, including quoted digits", () => {
    expect(matchedSearch("/pull-requests?q=fix")?.q).toBe("fix");
    expect(matchedSearch("/pull-requests?q=%224089%22")?.q).toBe("4089");
  });

  it("keeps a known grouping and sub-grouping and drops anything else", () => {
    const search = matchedSearch("/pull-requests?groupBy=repository&subGroupBy=review");
    expect(search?.groupBy).toBe("repository");
    expect(search?.subGroupBy).toBe("review");

    const unknown = matchedSearch("/pull-requests?groupBy=colour&subGroupBy=7");
    expect(unknown?.groupBy).toBeUndefined();
    expect(unknown?.subGroupBy).toBeUndefined();
    expect(
      matchedSearch("/pull-requests?groupBy=none&subGroupBy=review")?.subGroupBy,
    ).toBeUndefined();
    expect(
      matchedSearch("/pull-requests?groupBy=review&subGroupBy=review")?.subGroupBy,
    ).toBeUndefined();
    expect(
      matchedSearch("/pull-requests?groupBy=repository&subGroupBy=involvement")?.subGroupBy,
    ).toBeUndefined();
  });

  it("clears invalid sort and involvement values", () => {
    expect(matchedSearch("/pull-requests?involvement=reviewing&sort=updated")).toMatchObject({
      involvement: "reviewing",
      sort: "updated",
    });
    const invalid = matchedSearch("/pull-requests?involvement=unknown&sort=unknown");
    expect(invalid?.involvement).toBe("all");
    expect(invalid?.sort).toBeUndefined();
  });

  it("drops an author or labels the URL parser turned into a number", () => {
    expect(matchedSearch("/pull-requests?author=4089")?.author).toBeUndefined();
    expect(matchedSearch("/pull-requests?labels=4089")?.labels).toBeUndefined();
  });
});
