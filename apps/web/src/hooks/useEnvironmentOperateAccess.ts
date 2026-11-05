import type { EnvironmentId } from "@t3tools/contracts";

import { isElectron } from "../env";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentSessionState } from "../state/session";
import { resolveRemoteOperateAccess } from "../components/settings/ProviderSettingsPanel.logic";

// Same split the provider settings use: the desktop app owns its primary
// server outright; a browser session (primary or remote) checks the scopes
// its environment's session reports.
export function useEnvironmentOperateAccess(environmentId: EnvironmentId) {
  const isPrimary = usePrimaryEnvironmentId() === environmentId;
  const session = useEnvironmentSessionState(environmentId);
  if (isPrimary && isElectron) return "granted";
  return resolveRemoteOperateAccess({
    session: session.data,
    isPending: session.isPending,
    hasError: session.hasError,
  });
}
