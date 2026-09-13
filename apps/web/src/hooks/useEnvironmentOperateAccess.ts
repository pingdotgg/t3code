import type { EnvironmentId } from "@t3tools/contracts";

import { isElectron } from "../env";
import { usePrimarySessionState } from "../environments/primary";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentSessionState } from "../state/session";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "../components/settings/ProviderSettingsPanel.logic";

// Same split the provider settings use: the desktop app owns its primary
// server outright, a browser session on the primary checks its cookie
// session's scopes, and a remote checks the scopes its own server reports.
export function useEnvironmentOperateAccess(environmentId: EnvironmentId) {
  const isPrimary = usePrimaryEnvironmentId() === environmentId;
  const primarySession = usePrimarySessionState();
  const remoteSession = useEnvironmentSessionState(environmentId);
  if (isPrimary) {
    return isElectron
      ? "granted"
      : resolvePrimaryOperateAccess({
          isPrimary: true,
          hasDesktopBridge: false,
          session: primarySession.data,
          isPending: primarySession.isPending,
          hasError: primarySession.error !== null,
        });
  }
  return resolveRemoteOperateAccess({
    session: remoteSession.data,
    isPending: remoteSession.isPending,
    hasError: remoteSession.hasError,
  });
}
