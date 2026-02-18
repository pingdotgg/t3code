import { createHashHistory, createRouter } from "@tanstack/react-router";

import { isElectron } from "./env";
import { routeTree } from "./routeTree.gen";

const useHashHistory =
  isElectron && typeof window !== "undefined" && window.location.protocol === "file:";

export const router = createRouter({
  routeTree,
  ...(useHashHistory ? { history: createHashHistory() } : {}),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
