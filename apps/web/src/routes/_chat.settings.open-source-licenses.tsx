import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { createFileRoute } from "@tanstack/react-router";
import { definePluginFeature } from "~/plugins/features";

import { OpenSourceLicensesPanel } from "../components/settings/OpenSourceLicenses";

export const Route = createFileRoute("/_chat/settings/open-source-licenses")({
  component: definePluginRouteRenderer(
    "/settings/open-source-licenses",
    "component",
    definePluginFeature("settings.open-source-licenses", OpenSourceLicensesPanel),
  ),
});

registerBuiltinRoute("/settings/open-source-licenses", Route);
