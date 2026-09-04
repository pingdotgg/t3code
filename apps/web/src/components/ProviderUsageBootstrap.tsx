import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { useActiveEnvironmentId } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveThreadRouteRef } from "../threadRoutes";

const USAGE_REFRESH_INTERVAL_MS = 60_000;

/** Requests a fresh provider snapshot when the app connects to an environment. */
export function ProviderUsageBootstrap() {
  const activeEnvironmentId = useActiveEnvironmentId();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const refreshEnvironmentId = routeThreadRef?.environmentId ?? activeEnvironmentId;
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const refresh = useCallback(() => {
    if (refreshEnvironmentId === null) return;
    void refreshProviders({ environmentId: refreshEnvironmentId, input: {} });
  }, [refreshEnvironmentId, refreshProviders]);

  useEffect(() => {
    if (refreshEnvironmentId === null) {
      return;
    }

    refresh();
    const intervalId = window.setInterval(refresh, USAGE_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refresh);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh, refreshEnvironmentId]);

  return null;
}
