import { createElement } from "react";
import { createRouter, RouterHistory } from "@tanstack/react-router";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    context: {},
    Wrap: ({ children }) => createElement(AppAtomRegistryProvider, undefined, children),
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
