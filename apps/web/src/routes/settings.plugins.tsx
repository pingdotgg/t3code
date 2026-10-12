import { createFileRoute } from "@tanstack/react-router";
import { PluginsSettings } from "../components/settings/PluginsSettings";

export const Route = createFileRoute("/settings/plugins")({ component: PluginsSettings });
