import { createFileRoute } from "@tanstack/react-router";
import { ExtensionsSettings } from "../components/settings/ExtensionsSettings";
export const Route = createFileRoute("/_chat/settings/extensions")({
  component: ExtensionsSettings,
});
