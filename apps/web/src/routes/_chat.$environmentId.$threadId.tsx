import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: definePluginRouteRenderer("/_chat/$environmentId/$threadId", "component", () => null),
});

registerBuiltinRoute("/_chat/$environmentId/$threadId", Route);
