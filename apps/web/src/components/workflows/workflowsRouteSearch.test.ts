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

  it("clears an unusable pane or tab instead of keeping the raw search value", () => {
    const pane = JSON.stringify([
      { kind: "issue", key: "i412" },
      { kind: "pullRequest", key: "p418" },
    ]);
    for (const tab of ["", "null", "true"]) {
      const search = matchedSearch(`/workflows?${new URLSearchParams({ pane, tab })}`);
      expect(search?.pane).toHaveLength(2);
      expect(search?.tab).toBeUndefined();
    }
    for (const params of [
      new URLSearchParams({ pane: "nope", tab: "0" }),
      new URLSearchParams({ pane: "[]", tab: "" }),
      new URLSearchParams({ tab: "null" }),
    ]) {
      const search = matchedSearch(`/workflows?${params}`);
      expect(search?.pane).toBeUndefined();
      expect(search?.tab).toBeUndefined();
    }
  });
});
