import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

import AboutData from "./pages/about.data";
import Home from "./pages/home";

export const routes: Array<RouteDefinition> = [
  {
    path: "/",
    component: Home,
  },
  {
    path: "/about",
    component: lazy(() => import("./pages/about")),
    data: AboutData,
  },
  {
    path: "**",
    component: lazy(() => import("./errors/404")),
  },
];
