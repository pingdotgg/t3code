import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";

export function useRetryEnvironment() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const retryNow = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, "environment toggle");

  return (environmentId: EnvironmentId) =>
    // A retry does nothing while the environment is switched off.
    catalog.entries.get(environmentId)?.enabled === false
      ? setEnabled({ environmentId, enabled: true })
      : retryNow(environmentId);
}
