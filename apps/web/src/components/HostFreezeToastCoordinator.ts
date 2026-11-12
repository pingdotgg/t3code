import { hostFreezeNotice } from "@t3tools/client-runtime/connection";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import { environmentServerConfigsAtom } from "../state/server";
import { toastManager } from "./ui/toast";

/** Tells the user why a host dropped, once per stall, when it reports one on reconnect. */
export function startHostFreezeToasts(): () => void {
  const shown = new Set<string>();
  return appAtomRegistry.subscribe(
    environmentServerConfigsAtom,
    (configs) => {
      for (const [environmentId, config] of configs) {
        const stall = config.lastEventLoopStall;
        if (stall === undefined) continue;
        const key = `${environmentId}:${stall.detectedAt}`;
        if (shown.has(key)) continue;
        shown.add(key);
        const label =
          appAtomRegistry
            .get(environmentSummaries.identitiesAtom)
            .find((identity) => identity.environmentId === environmentId)?.label ??
          config.environment.label;
        const notice = hostFreezeNotice(label, stall);
        if (notice !== null) {
          toastManager.add({ type: "warning", ...notice });
        }
      }
    },
    { immediate: true },
  );
}
