import { createFileRoute } from "@tanstack/react-router";

import { LinearBrowser } from "../components/linear/LinearBrowser";

export const Route = createFileRoute("/_chat/linear")({
  component: LinearBrowser,
});
