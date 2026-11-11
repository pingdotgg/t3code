import type { unstable_RSCRouteConfigEntry } from "react-router";

export const routes: Array<unstable_RSCRouteConfigEntry> = [
  {
    id: "root",
    path: "",
    lazy: () => import("./root"),
    children: [
      {
        id: "home",
        index: true,
        lazy: () => import("./routes/home"),
      },
      {
        id: "about",
        path: "about",
        lazy: () => import("./routes/about"),
      },
    ],
  },
];
