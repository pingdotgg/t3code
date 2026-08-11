import { createFileRoute } from "@tanstack/react-router";

import { PluginPage } from "../components/plugins/PluginPage";

export const Route = createFileRoute("/plugins/$pluginId/$commandName")({
  component: () => {
    const { pluginId, commandName } = Route.useParams();
    return <PluginPage pluginId={pluginId} commandName={commandName} />;
  },
});
