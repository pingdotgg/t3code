import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";

import { usePrimaryCloudLinkState } from "~/cloud/primaryCloudLinkState";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { desktopWslStateAtom } from "~/state/desktopWslState";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { usePeerLinkHosts } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { isWslSettingsRowVisible } from "./ConnectionsSettings.logic";
import { isProviderSettingsEnvironmentAvailable } from "./ProviderSettingsPanel.logic";
import { resolveScopedSettingsTargets, selectScopedSettingsEnvironments } from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import {
  filterAvailableSettingsSearchItems,
  getThreadAutoSettlementSearchAvailability,
  hasThreadAutoSettleSnoozedOnMergeInScope,
} from "./settingsSearch";

export function useAvailableSettingsSearchItems(scopeSearch: SettingsScopeSearch = {}) {
  const { environments } = useEnvironments();
  const groups = useSettingsProjectGroups();
  const resolvedScope = resolveSettingsScope(scopeSearch, groups, environments);
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
  const hasMacProviderSettingsEnvironment =
    environments.some(
      (environment) =>
        (scopeSearch.machine === undefined || environment.environmentId === scopeSearch.machine) &&
        environment.serverConfig?.environment.platform.os === "darwin" &&
        isProviderSettingsEnvironmentAvailable({
          connectionPhase: environment.connection.phase,
          hasServerConfig: true,
        }),
    ) === true;
  const hasThreadAutoSettlement =
    getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The Threads panel hides the switch unless merge settlement is on for a scoped target.
  const hasScopedAutoSettleOnMerge = resolveScopedSettingsTargets(
    resolvedScope,
    selectScopedSettingsEnvironments(resolvedScope, environments, primaryEnvironmentId)
      .connectedEnvironments,
  ).some((target) => target.settings.sidebarAutoSettleOnMerge === true);
  const hasThreadAutoSettleSnoozedOnMerge =
    hasScopedAutoSettleOnMerge &&
    hasThreadAutoSettleSnoozedOnMergeInScope(environments, resolvedScope);
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const hasPeerLinkHost = usePeerLinkHosts().length > 0;
  const cloudLinkState = usePrimaryCloudLinkState().data;
  // Same fallback as the Connections row: older servers imply a tunnel from `linked`.
  const managedTunnelActive =
    cloudLinkState?.linkRevoked !== true &&
    (cloudLinkState?.managedTunnelActive ?? cloudLinkState?.linked ?? false) === true;
  const localEnvironmentDisabled = isLocalEnvironmentDisabled() === true;
  const canManageLocalBackend = !localEnvironmentDisabled && canMaintain;
  const desktopWsl = useEnvironmentQuery(
    isElectron && canManageLocalBackend ? desktopWslStateAtom : null,
  );
  const cloudPublicConfig = hasCloudPublicConfig() === true;
  const wslSettingsRowVisible =
    isWslSettingsRowVisible({ state: desktopWsl.data, error: desktopWsl.error }) === true;

  return filterAvailableSettingsSearchItems({
    localEnvironmentDisabled,
    hasCloudPublicConfig: cloudPublicConfig,
    hasEnvironment,
    hasProviderSettingsEnvironment,
    hasMacProviderSettingsEnvironment,
    canManageLocalBackend,
    isWslSettingsRowVisible: wslSettingsRowVisible,
    hasThreadAutoSettlement,
    hasThreadAutoSettleSnoozedOnMerge,
    managedTunnelActive,
    hasPeerLinkHost,
  });
}
