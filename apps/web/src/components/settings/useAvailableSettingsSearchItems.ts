import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";

import { isElectron } from "~/env";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { desktopWslStateAtom } from "~/state/desktopWslState";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useNetworkHosts } from "~/state/peerLinks";
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
  // Explicit booleans keep flags out of the filter cache so environment updates do not rebuild the list.
  const hasEnvironment =
    environments.some((environment) => environment.serverConfig !== null) === true;
  const hasProviderSettingsEnvironment =
    environments.some((environment) =>
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: environment.connection.phase,
        hasServerConfig: environment.serverConfig !== null,
      }),
    ) === true;
  // Any machine that offers it; the row then shows for a settings scope where all selected ones do.
  const hasFastWorktreeCheckoutEnvironment =
    environments.some(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.fastWorktreeCheckout === true,
    ) === true;
  const hasTextGeneratorsEnvironment =
    environments.some(
      (environment) =>
        environment.serverConfig !== null &&
        environment.serverConfig.managedPolicy?.limits?.providers?.allowedDrivers === undefined,
    ) === true;
  const hasThreadAutoSettlement =
    getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0;
  const hasThreadAutoSettleFinishedChildren =
    getThreadAutoSettlementSearchAvailability(
      environments,
      undefined,
      "threadAutoSettleFinishedChildren",
    ).eligibleEnvironmentIds.length > 0;
  const hasThreadAutoArchive =
    getThreadAutoSettlementSearchAvailability(environments, undefined, "threadAutoArchive")
      .eligibleEnvironmentIds.length > 0;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const hasPeerLinkHost = useNetworkHosts().length > 0;
  const localEnvironmentDisabled = isLocalEnvironmentDisabled() === true;
  const canManageLocalBackend = !localEnvironmentDisabled && canMaintain;
  const desktopWsl = useEnvironmentQuery(
    isElectron && canManageLocalBackend ? desktopWslStateAtom : null,
  );
  const wslSettingsRowVisible =
    isWslSettingsRowVisible({ state: desktopWsl.data, error: desktopWsl.error }) === true;

  return filterAvailableSettingsSearchItems({
    localEnvironmentDisabled,
    hasEnvironment,
    hasProviderSettingsEnvironment,
    canManageLocalBackend,
    isWslSettingsRowVisible: wslSettingsRowVisible,
    hasThreadAutoSettlement,
    hasThreadAutoSettleFinishedChildren,
    hasThreadAutoArchive,
    hasPeerLinkHost,
    hasFastWorktreeCheckoutEnvironment,
    hasTextGeneratorsEnvironment,
    hasPrimaryEnvironment: primaryEnvironmentId !== null,
  });
}
