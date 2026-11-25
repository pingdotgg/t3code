import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { Route as WorkflowsRoute } from "../../routes/_chat.workflows";

it("preserves the environment id from a workflow run URL", () => {
  const env = `${" ".repeat(200)}env-1`;
  const root = createRootRoute();
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const workflows = createRoute({
    getParentRoute: () => chat,
    path: "workflows",
    validateSearch: WorkflowsRoute.options.validateSearch,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat.addChildren([workflows])]),
    history: createMemoryHistory({
      initialEntries: [`/workflows?env=${encodeURIComponent(env)}&run=run-1`],
    }),
  });

  const search = router.matchRoutes(router.latestLocation).at(-1)?.search;
  expect(search?.env).toBe(env);
  expect(EnvironmentId.make(search?.env ?? "")).toBe(env);
});
