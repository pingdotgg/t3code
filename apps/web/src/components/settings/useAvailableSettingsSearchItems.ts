import { AuthEnvironmentMaintainScope, supportsLessonSideChats } from "@t3tools/contracts";

import { usePrimaryCloudLinkState } from "~/cloud/cloudLinkState";
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
import { hasSideChatSettings } from "./sideChatSettingsSupport";
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
  const hasThreadAutoSettlement =
    getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0;
  const hasSideChats = environments.some(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig !== null &&
      supportsLessonSideChats(environment.serverConfig.environment) &&
      hasSideChatSettings(environment.serverConfig.settings),
  );
  const hasKnowledgeMap = environments.some(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.knowledgeMap === true,
  );
  const hasCourses = environments.some(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.courses === true,
  );
  const hasChatSync = environments.some(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.chatSync === true,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
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
    canManageLocalBackend,
    isWslSettingsRowVisible: wslSettingsRowVisible,
    hasThreadAutoSettlement,
    hasSideChats,
    hasChatSync,
    hasKnowledgeMap,
    hasCourses,
    managedTunnelActive,
    hasPeerLinkHost,
  });
}
