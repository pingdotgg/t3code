import { useCallback, useEffect } from "react";

import { useActiveEnvironmentId } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

const USAGE_REFRESH_INTERVAL_MS = 60_000;

/** Requests a fresh provider snapshot when the app connects to an environment. */
export function ProviderUsageBootstrap() {
  const activeEnvironmentId = useActiveEnvironmentId();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const refresh = useCallback(() => {
    if (activeEnvironmentId === null) return;
    void refreshProviders({ environmentId: activeEnvironmentId, input: {} });
  }, [activeEnvironmentId, refreshProviders]);

  useEffect(() => {
    if (activeEnvironmentId === null) {
      return;
    }

    refresh();
    const intervalId = window.setInterval(refresh, USAGE_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refresh);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refresh);
    };
  }, [activeEnvironmentId, refresh]);

  return null;
}
