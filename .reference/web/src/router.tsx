import { createRouter, type RouterHistory } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

export const getRouter = (history: RouterHistory) =>
  createRouter({
    routeTree,
    history
  })


declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
