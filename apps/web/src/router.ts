import { createRouter, RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";
import { registerNavigationHistory } from "./navigationHistoryStore";

export function getRouter(history: RouterHistory) {
  registerNavigationHistory(history);
  return createRouter({
    routeTree,
    history,
    context: {},
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
