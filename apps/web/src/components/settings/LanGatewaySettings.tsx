import type { EnvironmentId, LanGatewayPeerSummary } from "@t3tools/contracts";

import { lanGatewayEnvironment } from "~/state/lanGateway";
import { useEnvironmentQuery } from "~/state/query";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function LanGatewaySettings({
  environmentId,
  environmentLabel,
  isSearchTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly isSearchTarget: boolean;
}) {
  const peers = useEnvironmentQuery(lanGatewayEnvironment.list({ environmentId, input: {} }));
  const search = searchableSetting("lan-gateway-peers");
  return (
    <SettingsSection
      {...(isSearchTarget ? { id: search.id } : {})}
      title={environmentLabel === null ? search.title : `${search.title} · ${environmentLabel}`}
    >
      {peers.error ? (
        <SettingsRow title="Could not load LAN gateway peers" description={peers.error} />
      ) : !peers.data ? (
        <SettingsRow title="Loading LAN gateway peers…" role="status" />
      ) : peers.data.peers.length === 0 ? (
        <SettingsRow
          title="No gateway peers yet"
          description="Enabled environments on this device that have a LAN or Tailscale address are registered automatically while LAN gateway is on."
        />
      ) : (
        peers.data.peers.map((peer) => <LanGatewayPeerRow key={peer.environmentId} peer={peer} />)
      )}
    </SettingsSection>
  );
}

function LanGatewayPeerRow({ peer }: { readonly peer: LanGatewayPeerSummary }) {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-medium text-foreground">{peer.label}</h3>
          <p className="truncate text-xs text-muted-foreground">{peer.httpBaseUrl}</p>
        </div>
      </div>
    </div>
  );
}
