import { createFileRoute } from "@tanstack/react-router";
import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";

import { UsagePage } from "../components/usage/UsagePage";

export const Route = createFileRoute("/_chat/usage")({
  component: definePluginRouteRenderer("/usage", "component", UsagePage),
});

registerBuiltinRoute("/usage", Route);
