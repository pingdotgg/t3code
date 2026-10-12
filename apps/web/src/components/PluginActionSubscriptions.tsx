import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentIds } from "../state/environments";
import { useMountPluginActions } from "../state/pluginActions";

function EnvironmentPluginActions(props: { readonly environmentId: EnvironmentId }) {
  useMountPluginActions(props.environmentId);
  return null;
}

/**
 * Keeps every environment's plugin actions subscribed, so thread menus built
 * when they open list them without waiting. A server without plugin actions
 * receives no subscription.
 */
export function PluginActionSubscriptions() {
  const environmentIds = useEnvironmentIds();
  return environmentIds.map((environmentId) => (
    <EnvironmentPluginActions key={environmentId} environmentId={environmentId} />
  ));
}
