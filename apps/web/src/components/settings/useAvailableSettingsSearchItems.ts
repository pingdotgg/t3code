import { useMemo } from "react";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { desktopWslStateAtom } from "~/state/desktopWslState";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { isWslSettingsRowVisible } from "./ConnectionsSettings.logic";
import { isProviderSettingsEnvironmentAvailable } from "./ProviderSettingsPanel.logic";
import {
  filterAvailableSettingsSearchItems,
  getThreadAutoSettlementSearchAvailability,
} from "./settingsSearch";

export function useAvailableSettingsSearchItems() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const localEnvironmentDisabled = isLocalEnvironmentDisabled();
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const canManageLocalBackend = !localEnvironmentDisabled && canMaintain;
  const desktopWsl = useEnvironmentQuery(
    isElectron && canManageLocalBackend ? desktopWslStateAtom : null,
  );

  return useMemo(
    () =>
      filterAvailableSettingsSearchItems({
        localEnvironmentDisabled,
        hasCloudPublicConfig: hasCloudPublicConfig(),
        hasEnvironment: environments.some((environment) => environment.serverConfig !== null),
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
          getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0,
      }),
    [
      canManageLocalBackend,
      desktopWsl.data,
      desktopWsl.error,
      environments,
      localEnvironmentDisabled,
    ],
  );
}
