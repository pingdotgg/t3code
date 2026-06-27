import { createRouter, RouterHistory } from "@tanstack/react-router";
import type { NormalizedBasePath } from "@t3tools/shared/basePath";

import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory, basepath: NormalizedBasePath) {
  return createRouter({
    routeTree,
    history,
    basepath,
    context: {},
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
