import { createRouter, RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    context: {},
    // Route components are split chunks (autoCodeSplitting in vite.config);
    // fetching them on hover/focus intent hides the load from the first
    // settings or pull-request navigation.
    defaultPreload: "intent",
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

/**
 * The router fetches split route chunks only after every beforeLoad resolves,
 * and the root beforeLoad waits on the auth check. Starting the initial
 * location's chunks during that check runs both at once. The index route
 * opens a draft right away, so its chunk starts too. The chunks start a task
 * later, so the boot's own requests reach the server ahead of them.
 */
export function preloadInitialRouteChunks(router: AppRouter) {
  const { pathname } = router.latestLocation;
  const routes = [...router.getMatchedRoutes(pathname).matchedRoutes];
  const draftRoute = router.looseRoutesById["/_chat/draft/$draftId"];
  if (pathname === "/" && draftRoute) routes.push(draftRoute);
  setTimeout(() => {
    for (const route of routes) {
      // Failures surface again when the router loads the same chunk.
      void Promise.resolve(router.loadRouteChunk(route)).catch(() => undefined);
    }
  }, 0);
}

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
