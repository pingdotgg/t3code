import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import * as Dialog from "../../components/ui/Dialog";
import { discoverTailnetMachines } from "../../connection/onboarding";
import { environmentCatalog } from "../../connection/catalog";
import { isAppActive, subscribeAppState } from "../../lib/appState";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";

const DISCOVERY_INTERVAL_MS = 5 * 60_000;
// Machines connect one by one at launch; one pass covers them all.
const DISCOVERY_MIN_GAP_MS = 30_000;

/**
 * App-lifetime worker: asks each connected machine for the T3 Code machines on
 * its tailnet and adds the ones that offer Tailscale sign-in. Runs on resume,
 * when a machine connects, and on an interval while active.
 */
export function installTailnetDiscovery(): () => void {
  let lastRunAt = 0;
  let connectedKey = "";
  let trailing: ReturnType<typeof setTimeout> | undefined;
  // Each conflict is worth one warning per launch, not one every few minutes.
  const warned = new Set<string>();

  const run = async () => {
    lastRunAt = Date.now();
    const result = await runAtomCommand(appAtomRegistry, discoverTailnetMachines, [], {
      label: discoverTailnetMachines.label,
      reportFailure: false,
    });
    if (result._tag !== "Success") return;
    const { added, conflicts } = result.value;
    if (added.length > 0) {
      Dialog.alert(
        added.length === 1 ? `Added ${added[0]!.label}` : `Added ${added.length} machines`,
        `${added.map((machine) => machine.label).join(", ")} ${
          added.length === 1 ? "was" : "were"
        } found on your tailnet. Remove a machine in Environments to stop adding it.`,
      );
    }
    for (const conflict of conflicts) {
      const key = `${conflict.label}@${conflict.address}`;
      if (warned.has(key)) continue;
      warned.add(key);
      Dialog.alert(
        `${conflict.label} answered at a new address`,
        `${conflict.address} is not one of its saved routes, so it was not added. Make sure that address is really this machine.`,
      );
    }
  };

  const update = (force: boolean) => {
    if (!isAppActive() || !appAtomRegistry.get(environmentCatalog.catalogValueAtom).isReady) return;
    const connected = [...appAtomRegistry.get(environmentPresentations.presentationsAtom)]
      .filter(([, presentation]) => presentation.connection.phase === "connected")
      .map(([id]) => id)
      .join(",");
    const changed = connected !== connectedKey;
    if (connected === "" || (!force && !changed)) {
      connectedKey = connected;
      return;
    }
    // A change inside the gap runs once the gap ends, not at the next interval.
    const wait = lastRunAt + DISCOVERY_MIN_GAP_MS - Date.now();
    if (wait > 0) {
      trailing ??= setTimeout(() => {
        trailing = undefined;
        update(true);
      }, wait);
      return;
    }
    connectedKey = connected;
    void run();
  };

  const unsubscribePresentations = appAtomRegistry.subscribe(
    environmentPresentations.presentationsAtom,
    () => update(false),
    { immediate: true },
  );
  const unsubscribeAppState = subscribeAppState(() => update(true));
  const timer = setInterval(() => update(true), DISCOVERY_INTERVAL_MS);
  return () => {
    unsubscribePresentations();
    unsubscribeAppState();
    clearInterval(timer);
    clearTimeout(trailing);
  };
}
