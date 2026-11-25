import { RegistryContext } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { useContext } from "react";

import { peerLinkEnvironment, usePeerLinkHosts } from "../../state/peerLinks";
import { sourceControlEnvironment } from "../../state/sourceControl";
import type { SettingsPath } from "./settingsSearch";
import { useOptionalSettingsScope } from "./SettingsScopeContext";

/**
 * Starts loading a settings section on hover or focus: its lazy route chunk, plus the slow
 * queries it opens with. Each query keeps its result for its idle TTL, so mounting and
 * releasing at once is enough for the page to find it warm.
 */
export function useSettingsSectionPrefetch() {
  const router = useRouter();
  const registry = useContext(RegistryContext);
  const environment = useOptionalSettingsScope()?.environment ?? null;
  const peerLinkHosts = usePeerLinkHosts();
  return (to: SettingsPath) => {
    void router.preloadRoute({ to });
    if (to === "/settings/source-control" && environment?.connection.phase === "connected") {
      const input = { environmentId: environment.environmentId, input: {} };
      registry.mount(sourceControlEnvironment.discovery(input))();
    }
    if (to === "/settings/connections") {
      for (const host of peerLinkHosts) {
        const input = { environmentId: host.environmentId, input: {} };
        registry.mount(peerLinkEnvironment.list(input))();
      }
    }
  };
}
