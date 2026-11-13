import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

function SettingsConnectionsRoute() {
  return <ConnectionsSettings view="environments" />;
}

export const Route = createFileRoute("/_chat/settings/connections")({
  // `connect` opens Add environment at that address, as "Continue on another machine" does.
  validateSearch: (raw: Record<string, unknown>) =>
    typeof raw.connect === "string" && raw.connect.trim() ? { connect: raw.connect.trim() } : {},
  component: SettingsConnectionsRoute,
});
