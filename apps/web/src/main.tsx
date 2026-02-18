import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createRouter, createBrowserHistory } from "@tanstack/react-router";
import { StoreProvider } from "./store";

import "@xterm/xterm/css/xterm.css";
import "highlight.js/styles/github-dark.css";
import "./index.css";

import { isElectron } from "./env";
import { routeTree } from "./routeTree.gen";

const history = isElectron ? createHashHistory() : createBrowserHistory();

const queryClient = new QueryClient();

const router = createRouter({
  routeTree,
  history,
  context: {
    queryClient,
  },
  Wrap: ({ children }) => (
    <QueryClientProvider client={queryClient}>
      <StoreProvider>{children}</StoreProvider>
    </QueryClientProvider>
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
