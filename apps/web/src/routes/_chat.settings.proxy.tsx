import { createFileRoute } from "@tanstack/react-router";
import { CliProxySettingsPanel } from "../components/settings/CliProxySettings";

export const Route = createFileRoute("/_chat/settings/proxy")({
  component: CliProxySettingsPanel,
});
