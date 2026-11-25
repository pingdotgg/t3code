import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
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
  it("preserves the environment id from a workflow run URL", () => {
    const env = `${" ".repeat(200)}env-1`;
    const matchedEnv = matchedSearch(`/workflows?env=${encodeURIComponent(env)}&run=run-1`)?.env;
    expect(matchedEnv).toBe(env);
    expect(typeof matchedEnv === "string" && EnvironmentId.make(matchedEnv)).toBe(env);
  });

  it("keeps env intact and cuts run and file before an emoji the limit would split", () => {
    const env = `${"a".repeat(199)}😀`;
    const run = "b".repeat(199);
    const file = "c".repeat(199);
    expect(
      matchedSearch(
        `/workflows?${new URLSearchParams({
          env,
          run: `${run}🐛`,
          file: `${file}🚀`,
        })}`,
      ),
    ).toMatchObject({ env, run, file });
  });
});
