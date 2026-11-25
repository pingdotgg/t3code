import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { Route as WorkflowsRoute } from "../../routes/_chat.workflows";

function matchedSearch(url: string) {
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const workflows = createRoute({
    getParentRoute: () => chat,
    path: "workflows",
    validateSearch: WorkflowsRoute.options.validateSearch,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([workflows])]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  return router.matchRoutes(router.latestLocation).at(-1)?.search as
    | Record<string, unknown>
    | undefined;
}

describe("workflows route search", () => {
  it("cuts a long env, run and file before an emoji the limit would split", () => {
    const env = "a".repeat(199);
    const run = "b".repeat(199);
    const file = "c".repeat(199);
    expect(
      matchedSearch(
        `/workflows?${new URLSearchParams({
          env: `${env}😀`,
          run: `${run}🐛`,
          file: `${file}🚀`,
        })}`,
      ),
    ).toMatchObject({ env, run, file });
  });
});
