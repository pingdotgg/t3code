import { createRouter, RouterHistory } from "@tanstack/react-router";

import { isElectron } from "./env";
import { trackNavigationHistory } from "./navigationHistory";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  // Only the desktop titlebar shows Forward; browsers bring their own buttons.
  if (isElectron) trackNavigationHistory(history);
  return createRouter({
    routeTree,
    history,
    context: {},
    defaultPreload: "intent",
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
