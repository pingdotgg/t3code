import { Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { ChatThreadRouteView } from "./routes/_chat.$threadId";
import { ChatIndexRouteView } from "./routes/_chat.index";
import { ChatRouteLayout } from "./routes/_chat";

const rootRoute = createRootRoute({
  component: Outlet,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ChatRouteLayout,
});

const chatIndexRoute = createRoute({
  getParentRoute: () => chatRoute,
  path: "/",
  component: ChatIndexRouteView,
});

const chatThreadRoute = createRoute({
  getParentRoute: () => chatRoute,
  path: "$threadId",
  component: ChatThreadRouteView,
});

const routeTree = rootRoute.addChildren([chatRoute.addChildren([chatIndexRoute, chatThreadRoute])]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
