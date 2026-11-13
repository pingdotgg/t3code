import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";
import { connectLinkOrigin } from "../components/settings/ConnectionsSettings.logic";

function SettingsConnectionsRoute() {
  return <ConnectionsSettings view="environments" />;
}

export const Route = createFileRoute("/_chat/settings/connections")({
  // `connect` opens Add environment at that address, as "Continue on another machine" does.
  // Only the origin stays, so the link can never carry a pairing token.
  validateSearch: (raw: Record<string, unknown>) => {
    const origin = connectLinkOrigin(raw.connect);
    return origin === null ? {} : { connect: origin };
  },
  component: SettingsConnectionsRoute,
});
