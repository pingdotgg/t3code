import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { desktopWslStateAtom } from "~/state/desktopWslState";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { primaryServerConfigAtom } from "~/state/server";
import { isWslSettingsRowVisible } from "./ConnectionsSettings.logic";
import { isProviderSettingsEnvironmentAvailable } from "./ProviderSettingsPanel.logic";
import { filterAvailableSettingsSearchItems } from "./settingsSearch";

export function useAvailableSettingsSearchItems() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const primaryServerConfig = useAtomValue(primaryServerConfigAtom);
  const canManageLocalBackend = useEnvironmentScope(
    primaryEnvironmentId,
    AuthEnvironmentMaintainScope,
  );
  const desktopWsl = useEnvironmentQuery(
    isElectron && canManageLocalBackend ? desktopWslStateAtom : null,
  );

  return useMemo(
    () =>
      filterAvailableSettingsSearchItems({
        hasCloudPublicConfig: hasCloudPublicConfig(),
        hasPrimaryEnvironment: primaryEnvironmentId !== null,
        hasProviderSettingsEnvironment: environments.some((environment) =>
          isProviderSettingsEnvironmentAvailable({
            connectionPhase: environment.connection.phase,
            hasServerConfig: environment.serverConfig !== null,
          }),
        ),
        canManageLocalBackend,
        isWslSettingsRowVisible: isWslSettingsRowVisible({
          state: desktopWsl.data,
          error: desktopWsl.error,
        }),
        hasThreadAutoSettlement:
          primaryServerConfig?.environment.capabilities.threadAutoSettlement === true,
      }),
    [
      canManageLocalBackend,
      desktopWsl.data,
      desktopWsl.error,
      environments,
      primaryEnvironmentId,
      primaryServerConfig,
    ],
  );
}
