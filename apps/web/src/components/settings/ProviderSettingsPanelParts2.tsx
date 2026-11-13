import { SettingsGroup } from "./SettingsGroup";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import { useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type AcpRegistryUrlAuthAction,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProjectId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  resolveEnvironmentMachineKind,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
  useUpdateEnvironmentSettings,
  useUpdateEnvironmentModelPreferences,
  useToggleEnvironmentModelFavorite,
} from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { ensureLocalApi } from "../../localApi";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { cn } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import {
  EMPTY_SERVER_PROVIDERS,
  providersIgnoringCheckedAtAtom,
  serverEnvironment,
} from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import {
  isProviderSettingsUpdateCandidate,
  isProviderUpdateActive,
  type ProviderSettingsUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { ProviderUpdatesAction } from "../ProviderUpdatesAction";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { useManagedPolicy } from "~/state/managedPolicy";
import { ExpandableText } from "./ExpandableText";
import { IntervalSecondsField } from "./IntervalSecondsField";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { useSecretSources } from "./SecretSourceInput";
import { UsageProviderSettings } from "./UsageProviderSettings";
import { ProviderSetupSection, readAntigravityAuthMethod } from "./ProviderSetupSection";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { CodexSetupSection, CodexManagedRuntimeFields } from "./CodexSetupSection";
import { readCodexSetupMode } from "./CodexSetupSection.logic";
import { providerClients } from "./providerDriverMeta";
import { searchableSetting } from "./settingsSearch";
import { CompactIdleThreadsRow } from "./SettingsPanels";
import {
  backgroundActivityOverrideSettings,
  buildProviderInstanceUpdatePatch,
  durationToSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
} from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import {
  buildProviderEnvironmentOptions,
  buildProviderInstanceOverridePatch,
  classifyProviderEnvironmentAccess,
  isProviderSettingsEnvironmentAvailable,
  type ProviderEnvironmentAccess,
  type ProviderOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";
import { EnvironmentProviderSettings } from "./ProviderSettingsPanelParts";
import type { ProviderInstanceRowActions } from "./ProviderSettingsPanel";
import { NO_MODELS, configuredBinaryPath, modelListChanges } from "./ProviderSettingsPanel";

export function ProviderInstanceRow({
  environmentId,
  environmentLabel,
  instanceId,
  driver,
  explicitInstance,
  isDefault,
  isDirty,
  mode,
  selected,
  readOnly,
  canWriteSettings,
  liveProvider,
  isUpdateDispatching,
  showProjectOverride,
  projectOverrideValue,
  projectOverrideEffectiveEnabled,
  modelPreferences,
  favorites,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly explicitInstance: ProviderInstanceConfig | undefined;
  readonly isDefault: boolean;
  readonly isDirty: boolean;
  readonly mode: "list" | "editor";
  readonly selected: boolean;
  readonly readOnly: boolean;
  readonly canWriteSettings: boolean;
  readonly liveProvider: ServerProvider | undefined;
  readonly isUpdateDispatching: boolean;
  readonly showProjectOverride: boolean;
  readonly projectOverrideValue: boolean | undefined;
  readonly projectOverrideEffectiveEnabled: boolean;
  readonly modelPreferences:
    | { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> }
    | undefined;
  readonly favorites: UnifiedSettings["favorites"];
  readonly actions: ProviderInstanceRowActions;
}) {
  const allProjects = useProjects();
  const secretSources = useSecretSources(environmentId);
  const acpProjects =
    mode === "editor" && liveProvider?.driver === "acpRegistry"
      ? allProjects.filter((project) => project.environmentId === environmentId)
      : undefined;
  const instance = explicitInstance ?? { driver };
  const driverOption = providerClients.get(driver);
  const updateCandidate =
    liveProvider !== undefined && isProviderSettingsUpdateCandidate(liveProvider)
      ? liveProvider
      : undefined;
  const isInstanceUpdateRunning =
    isUpdateDispatching || (liveProvider !== undefined && isProviderUpdateActive(liveProvider));
  const hiddenModels = modelPreferences?.hiddenModels ?? NO_MODELS;
  const modelOrder = modelPreferences?.modelOrder ?? NO_MODELS;
  const favoriteModels = Arr.filterMap(favorites, (favorite) =>
    favorite.provider === instanceId ? Result.succeed(favorite.model) : Result.failVoid,
  );
  const resetLabel = driverOption?.label ?? String(driver);
  const projectOverride = showProjectOverride
    ? {
        value: projectOverrideValue,
        effectiveEnabled: projectOverrideEffectiveEnabled,
        onChange: (next: boolean) => actions.writeProjectOverride(instanceId, next),
        onReset: () => actions.writeProjectOverride(instanceId, undefined),
      }
    : undefined;
  const codexSetupMode = driver === "codex" ? readCodexSetupMode(instance.config) : null;
  const recommendedVersion = liveProvider?.compatibilityAdvisory?.recommendedVersion;
  const canInstallRecommended =
    !readOnly &&
    liveProvider !== undefined &&
    Boolean(liveProvider.compatibilityAdvisory?.message) &&
    Boolean(recommendedVersion) &&
    liveProvider.versionAdvisory?.canInstallVersion === true;

  return (
    <ProviderInstanceCard
      environmentId={environmentId}
      secretSources={secretSources}
      acpProjects={acpProjects}
      projectOverride={projectOverride}
      onAcceptUrlAuth={
        readOnly ? undefined : (action) => actions.acceptUrlAuthentication(instanceId, action)
      }
      instanceId={instanceId}
      instance={instance}
      driverOption={driverOption}
      liveProvider={liveProvider}
      mode={mode}
      selected={selected}
      onSelect={mode === "list" ? () => actions.selectInstance(instanceId) : undefined}
      readOnly={readOnly}
      runtime={
        mode === "editor" && codexSetupMode === "managed" ? (
          <CodexManagedRuntimeFields
            environmentId={environmentId}
            instanceId={instanceId}
            provider={liveProvider}
          />
        ) : undefined
      }
      canWriteSettings={canWriteSettings}
      setup={
        mode === "editor" && driver === "antigravity" ? (
          <ProviderSetupSection
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={instanceId}
            provider={liveProvider}
            binaryPath={configuredBinaryPath(instance.config)}
            authMethod={readAntigravityAuthMethod(instance.config)}
            enabled={resolveProviderInstanceEnabled(instance)}
            readOnly={readOnly}
            onEnable={() => actions.enableInstance(instanceId, { ...instance, enabled: true })}
          />
        ) : mode === "editor" && codexSetupMode === "managed" ? (
          <CodexSetupSection
            environmentId={environmentId}
            instanceId={instanceId}
            provider={liveProvider}
            mode={codexSetupMode}
            enabled={resolveProviderInstanceEnabled(instance)}
            readOnly={readOnly}
            onModeChange={(setupMode) =>
              actions.enableInstance(instanceId, {
                ...instance,
                enabled: true,
                config: {
                  ...(instance.config !== null && typeof instance.config === "object"
                    ? instance.config
                    : {}),
                  enabled: true,
                  setupMode,
                },
              })
            }
          />
        ) : mode === "editor" &&
          !readOnly &&
          liveProvider &&
          (liveProvider.setup?.canAuthenticate ||
            (liveProvider.driver === "acpRegistry" && liveProvider.installed)) ? (
          <ProviderAuthenticationSection
            key={`${environmentId}:${instanceId}`}
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={instanceId}
            provider={liveProvider}
            readOnly={readOnly}
          />
        ) : mode === "editor" &&
          !readOnly &&
          driver === "cursor" &&
          liveProvider?.setup?.canAuthenticate === false ? (
          <SettingsRow
            title="Cursor account"
            description="Using CURSOR_API_KEY. Remove it from this provider's environment to use browser sign-in."
          />
        ) : null
      }
      onUpdate={(next) => actions.updateInstance(instanceId, instance, next)}
      onDelete={
        mode === "editor" && !isDefault
          ? () => actions.deleteInstance(instanceId, instance)
          : undefined
      }
      headerAction={
        mode === "editor" && isDefault && isDirty ? (
          <SettingResetButton
            label={`${resetLabel} provider settings`}
            onClick={() => actions.resetDefaultInstance(driver)}
          />
        ) : null
      }
      hiddenModels={hiddenModels}
      favoriteModels={favoriteModels}
      modelOrder={modelOrder}
      onHiddenModelsChange={(next, affectedModels) => {
        const hidden = new Set(next);
        void actions.updateModelPreferences({
          setModelsHidden: affectedModels.map((model) => ({
            provider: instanceId,
            model,
            hidden: hidden.has(model),
          })),
        });
      }}
      onToggleFavorite={(model) => {
        void actions.toggleModelFavorite(instanceId, model);
      }}
      onFavoriteModelsChange={(next) => {
        void actions.updateModelPreferences({
          setModelFavorites: modelListChanges(favoriteModels, next).map(({ model, selected }) => ({
            provider: instanceId,
            model,
            favorite: selected,
          })),
        });
      }}
      onModelOrderChange={(nextOrder) => {
        void actions.updateModelPreferences({
          setProviderModelOrder: { provider: instanceId, modelOrder: nextOrder },
        });
      }}
      onInstallRecommended={
        canInstallRecommended
          ? () => {
              void actions.runProviderUpdate(liveProvider, recommendedVersion ?? undefined);
            }
          : undefined
      }
      onRunUpdate={
        !readOnly && updateCandidate
          ? () => {
              if (!isInstanceUpdateRunning) void actions.runProviderUpdate(updateCandidate);
            }
          : undefined
      }
      isUpdating={isInstanceUpdateRunning}
    />
  );
}
export * from "./ProviderSettingsPanelParts";

