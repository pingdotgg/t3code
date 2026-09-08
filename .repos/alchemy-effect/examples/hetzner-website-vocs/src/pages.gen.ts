// prettier-ignore
import type { PathsForPages } from "waku/router";

type Page =
  | { path: "/counter"; render: "static" }
  | { path: "/guide"; render: "static" }
  | { path: "/"; render: "static" };

declare module "waku/router" {
  interface RouteConfig {
    paths: PathsForPages<Page>;
  }
  interface CreatePagesConfig {
    pages: Page;
  }
}
