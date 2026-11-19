import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

function SettingsMobileAccessRoute() {
  return <ConnectionsSettings view="mobile" />;
}

export const Route = createFileRoute("/_chat/settings/mobile-access")({
  component: SettingsMobileAccessRoute,
});
