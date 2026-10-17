import { createRouter, RouterHistory } from "@tanstack/react-router";

import { preloadRouteSpeculatively } from "./lib/chunkReloadGuard";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  const router = createRouter({
    routeTree,
    history,
    context: {},
    defaultPreload: "intent",
  });
  // Failed intent preloads reload only when navigation renders the route.
  const preloadRoute = router.preloadRoute;
  router.preloadRoute = ((options: Parameters<typeof preloadRoute>[0]) =>
    preloadRouteSpeculatively(() => preloadRoute(options))) as typeof preloadRoute;
  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

// Overlap route chunks with auth; defer one task so boot requests start first.
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
