import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("api/hello", "routes/api.hello.ts"),
] satisfies RouteConfig;
