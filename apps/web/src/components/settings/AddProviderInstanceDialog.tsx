import { useT } from "../../hooks/useI18n";
import { createTranslator, type TranslateFn } from "@t3tools/client-runtime/i18n";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import {
  deriveAvailableInstanceId,
  deriveInstanceId,
} from "@t3tools/client-runtime/provider-instance-ids";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ProviderClientDefinition } from "@t3tools/provider-core/client";
import {
  type AcpRegistrySearchAgent,
  AuthProvidersManageScope,
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  isManagedDriverAllowed,
} from "@t3tools/contracts";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";

import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { managedInstanceLocks, useManagedPolicy } from "../../state/managedPolicy";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { ChatGptConnectionButton } from "./ChatGptConnectionButton";
import { Dialog } from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { providerClients } from "./providerDriverMeta";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { WizardPanel, WizardPopup, WizardHeader, WizardFooter } from "../ui/wizard";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  ACP_REGISTRY_WIZARD_STEPS,
  LOCAL_ACP_WIZARD_STEPS,
  resolveAcpRegistryWizardNavigation,
  resolveWizardNavigation,
  updateProviderIdentityDraft,
  type ProviderIdentityDraft,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { AcpRegistrySearchStep, useAcpRegistrySearch } from "./AcpRegistrySearchStep";
import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";
import { resolveOfficialAcpRegistryIconUrl } from "./AcpRegistryIcon";
import { AddManagedCodexAccountDialog } from "./CodexSetupSection";
import { MultipleAccountsNote } from "./MultipleAccountsNote";
import { ProviderEnvironmentSection } from "./ProviderInstanceCard";
import { useSecretSources } from "./SecretSourceInput";

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const DEFAULT_DRIVER_OPTION = providerClients.definitions[0]!;
const DRIVER_OPTIONS = providerClients.definitions.filter(
  (option) => option.driverKind !== ACP_REGISTRY_DRIVER_KIND,
);
const FEATURED_DRIVER_OPTIONS = DRIVER_OPTIONS.filter((option) => option.featured !== false);
const MORE_DRIVER_OPTIONS = DRIVER_OPTIONS.filter((option) => option.featured === false);
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
function validateInstanceId(
  id: string,
  existing: ReadonlySet<string>,
  t: TranslateFn = createTranslator("en"),
): string | null {
  if (id.length === 0) return t("settings.providers.instance.idRequired");
  if (id.length > 64) return t("settings.providers.instance.idTooLong");
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return t("settings.providers.instance.idPattern");
  }
  if (existing.has(id)) return t("settings.providers.instance.idExists", { id: String(id) });
  return null;
}

function ProviderOptionGrid({
  options,
  value,
  disabled,
  onValueChange,
  ...labelProps
}: {
  readonly options: ReadonlyArray<ProviderClientDefinition>;
  readonly value: ProviderDriverKind;
  readonly disabled: boolean;
  readonly onValueChange: (value: string) => void;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
}) {
  return (
    <RadioGroup
      {...labelProps}
      disabled={disabled}
      value={value}
      onValueChange={onValueChange}
      className="grid grid-cols-1 sm:grid-cols-2"
    >
      {options.map((option) => (
        <RadioPrimitive.Root
          key={option.driverKind}
          value={option.driverKind}
          className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
        >
          <ProviderInstanceIcon
            driverKind={option.driverKind}
            displayName={option.label}
            iconClassName="size-4"
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {option.label}
          </span>
          <RadioPrimitive.Indicator
            className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
            aria-hidden
          >
            <CheckIcon className="size-3.5 shrink-0" />
          </RadioPrimitive.Indicator>
          {option.badgeLabel ? (
            <Badge variant="warning" size="sm">
              {option.badgeLabel}
            </Badge>
          ) : null}
        </RadioPrimitive.Root>
      ))}
    </RadioGroup>
  );
}

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated?: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => void;
  /** Opens with "Show more" expanded, so the ACP Registry search is in view. */
  readonly showMoreProviders?: boolean;
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  onOpenChange,
  onCreated,
  showMoreProviders: initialShowMoreProviders = false,
}: AddProviderInstanceDialogProps) {
  const t = useT();
  const settings = useEnvironmentSettings(environmentId);
  const secretSources = useSecretSources(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);

  const [wizardStep, setWizardStep] = useState(0);
  const [addingChatGptAccount, setAddingChatGptAccount] = useState(false);
  // Drivers the administrator's policy leaves out are not offered at all.
  const managedPolicy = useManagedPolicy(environmentId);
  const featuredDriverOptions = FEATURED_DRIVER_OPTIONS.filter((option) =>
    isManagedDriverAllowed(managedPolicy, option.driverKind),
  );
  const moreDriverOptions = MORE_DRIVER_OPTIONS.filter((option) =>
    isManagedDriverAllowed(managedPolicy, option.driverKind),
  );
  const acpRegistryAllowed = isManagedDriverAllowed(managedPolicy, ACP_REGISTRY_DRIVER_KIND);
  const [driver, setDriver] = useState<ProviderDriverKind>(
    () =>
      (featuredDriverOptions[0] ?? moreDriverOptions[0])?.driverKind ??
      (acpRegistryAllowed ? ACP_REGISTRY_DRIVER_KIND : DEFAULT_DRIVER_KIND),
  );
  const [identityByDriver, setIdentityByDriver] = useState<Record<string, ProviderIdentityDraft>>(
    {},
  );
  const [selectedAcp, setSelectedAcp] = useState<AcpRegistrySearchAgent | null>(null);
  const [localEnvironment, setLocalEnvironment] = useState<
    ReadonlyArray<ProviderInstanceEnvironmentVariable>
  >([]);
  const [isManualAcpConfiguration, setIsManualAcpConfiguration] = useState(false);
  const [showMoreProviders, setShowMoreProviders] = useState(initialShowMoreProviders);
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [createdInstanceId, setCreatedInstanceId] = useState<ProviderInstanceId | null>(null);

  // Reserve Codex/Claude default ids because they run before configuration; other unconfigured slots are
  // available.
  const existingIds = new Set([
    "codex",
    "claudeAgent",
    ...Object.keys(settings.providerInstances ?? {}),
  ]);

  const driverOption = providerClients.get(driver) ?? DEFAULT_DRIVER_OPTION;
  const isAcpRegistry = driver === ACP_REGISTRY_DRIVER_KIND;
  const showRegistrySearch =
    !createdInstanceId &&
    !addingChatGptAccount &&
    wizardStep === 0 &&
    !(isAcpRegistry && isManualAcpConfiguration);
  // Searches while Show more is closed, so the fold opens on results.
  const registry = useAcpRegistrySearch(environmentId, showRegistrySearch);
  const isPreparingRegistryAgent = registry.preparingId !== null;
  const defaultIdentity: ProviderIdentityDraft = {
    label: driverOption.label,
    accentColor: "",
    instanceIdOverride: null,
  };
  const { label, accentColor, instanceIdOverride } = identityByDriver[driver] ?? defaultIdentity;
  const instanceId =
    instanceIdOverride ??
    deriveAvailableInstanceId(
      (candidateLabel) => {
        if (!candidateLabel.trim() || candidateLabel === driverOption.label) {
          return isAcpRegistry ? `${driver}_custom` : driver;
        }
        return deriveInstanceId(driver, candidateLabel);
      },
      label,
      existingIds,
    );
  const driverSettingsFields = deriveProviderSettingsFields(driverOption);
  const instanceIdError = validateInstanceId(instanceId, existingIds, t);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const identityStep = 1;
  const previewLabel = label.trim() || `${driverOption.label} Workspace`;

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const isLocalAcp = isAcpRegistry && isManualAcpConfiguration && configDraft.source === "local";
  const localCommandPath =
    typeof configDraft.commandPath === "string" ? configDraft.commandPath.trim() : "";
  const manualAgentId = typeof configDraft.agentId === "string" ? configDraft.agentId.trim() : "";
  const acpSelectionError = isLocalAcp
    ? localCommandPath.length > 0
      ? null
      : t("settings.providers.instance.executableRequired")
    : selectedAcp !== null || (isManualAcpConfiguration && manualAgentId.length > 0)
      ? null
      : t("settings.providers.instance.selectAcp");
  const wizardStepSummaries = isAcpRegistry
    ? ([
        isLocalAcp
          ? t("settings.providers.acp.localCommand")
          : (selectedAcp?.name ?? (manualAgentId || null)),
        previewLabel,
        null,
      ] as const)
    : ([driverOption.label, previewLabel, null] as const);
  const setConfigDraft = (config: Record<string, unknown> | undefined) => {
    setConfigByDriver((existing) => {
      const next = { ...existing };
      if (config === undefined || Object.keys(config).length === 0) {
        delete next[driver];
      } else {
        next[driver] = config;
      }
      return next;
    });
  };
  const selectDriver = (value: string) => {
    setDriver(ProviderDriverKind.make(value));
    setIsManualAcpConfiguration(false);
    setHasAttemptedSubmit(false);
  };
  const setIdentityDraft = (update: Partial<ProviderIdentityDraft>) => {
    setIdentityByDriver((existing) => ({
      ...existing,
      [driver]: { ...(existing[driver] ?? defaultIdentity), ...update },
    }));
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (isSaving || isPreparingRegistryAgent || createdInstanceId) return;
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    if (isAcpRegistry && !isLocalAcp && navigation.kind === "navigate" && navigation.step === 2) {
      void handleSave();
      return;
    }
    setWizardStep(navigation.step);
  };

  const navigateToStep = (requestedStep: number) => {
    applyWizardNavigation(
      isAcpRegistry
        ? isLocalAcp
          ? resolveWizardNavigation(wizardStep, requestedStep, LOCAL_ACP_WIZARD_STEPS.length, {
              instanceIdError,
              prerequisite: { step: 0, error: acpSelectionError },
            })
          : resolveAcpRegistryWizardNavigation(wizardStep, requestedStep, {
              instanceIdError,
              selectionError: acpSelectionError,
            })
        : resolveWizardNavigation(wizardStep, requestedStep, ADD_PROVIDER_WIZARD_STEPS.length, {
            instanceIdError,
          }),
    );
  };

  const handleAcpPrepared = (agent: AcpRegistrySearchAgent) => {
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    const nextLabel = agent.name;
    const registryIconUrl = resolveOfficialAcpRegistryIconUrl(agent.icon);
    const nextInstanceId = deriveAvailableInstanceId(
      (candidateLabel) => deriveInstanceId(ACP_REGISTRY_DRIVER_KIND, candidateLabel),
      nextLabel,
      existingIds,
    );
    setSelectedAcp(agent);
    setIsManualAcpConfiguration(false);
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: nextLabel,
        instanceIdOverride: nextInstanceId,
      }),
    );
    setConfigByDriver((existing) => ({
      ...existing,
      [ACP_REGISTRY_DRIVER_KIND]: {
        agentId: agent.id,
        distribution: "auto",
        ...(registryIconUrl ? { registryIconUrl } : {}),
      },
    }));
    setHasAttemptedSubmit(false);
    setWizardStep(1);
  };

  const handleManualAcpConfiguration = () => {
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    setSelectedAcp(null);
    setIsManualAcpConfiguration(true);
    setConfigByDriver((existing) => {
      const next = { ...existing };
      delete next[ACP_REGISTRY_DRIVER_KIND];
      return next;
    });
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: "",
        instanceIdOverride: null,
      }),
    );
    setHasAttemptedSubmit(false);
  };

  const handleLocalAcpConfiguration = () => {
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    setSelectedAcp(null);
    setIsManualAcpConfiguration(true);
    setConfigByDriver((existing) => ({
      ...existing,
      [ACP_REGISTRY_DRIVER_KIND]: { source: "local", commandArgs: [] },
    }));
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: "Local ACP",
        instanceIdOverride: null,
      }),
    );
    setLocalEnvironment([]);
    setHasAttemptedSubmit(false);
  };

  // A policy that owns this driver's launch settings also rules out ChatGPT's own runtime.
  const driverLocks = managedInstanceLocks(managedPolicy, driver);

  const handleSave = async () => {
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    if (isSaving || createdInstanceId) return;
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null || (isAcpRegistry && acpSelectionError !== null)) return;

    const config =
      driver === "codex"
        ? { ...configByDriver[driver], setupMode: "existing" }
        : (configByDriver[driver] ?? {});
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(hasConfig ? { config } : {}),
      ...(isLocalAcp && localEnvironment.length > 0 ? { environment: localEnvironment } : {}),
    };
    const brandedId = ProviderInstanceId.make(instanceId);
    setIsSaving(true);
    const result = await persistProviderInstance({
      operation: "create",
      instanceId: brandedId,
      instance: nextInstance,
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setIsSaving(false);
      toastManager.add({
        type: "error",
        title: t("settings.providers.instance.addFailed"),
        description:
          error instanceof Error ? error.message : t("settings.providers.instance.settingsFailed"),
      });
      return;
    }
    onCreated?.(brandedId, driver);
    if (isAcpRegistry && !isLocalAcp) {
      setCreatedInstanceId(brandedId);
      setIsSaving(false);
      setWizardStep(2);
      return;
    }
    toastManager.add({
      type: "success",
      title: t("settings.providers.instance.added"),
      description: t("settings.providers.instance.addedDescription", {
        driver: String(driverOption.label),
        id: String(instanceId),
      }),
    });
    onOpenChange(false);
  };

  if (addingChatGptAccount) {
    return (
      <AddManagedCodexAccountDialog
        environmentId={environmentId}
        onClose={() => onOpenChange(false)}
        onAccountCreated={(instanceId) => onCreated?.(instanceId, ProviderDriverKind.make("codex"))}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WizardPopup size="wide">
        <WizardHeader
          title={t("settings.providers.instance.addProvider")}
          description={t("settings.providers.instance.addDescription", {
            environment: environmentLabel,
          })}
        >
          {isAcpRegistry ? (
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              steps={isLocalAcp ? LOCAL_ACP_WIZARD_STEPS : ACP_REGISTRY_WIZARD_STEPS}
              disabled={isSaving || isPreparingRegistryAgent || createdInstanceId !== null}
              identityStep={1}
              prerequisite={{ step: 0, error: acpSelectionError }}
              onNavigation={applyWizardNavigation}
            />
          ) : (
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              disabled={isSaving || isPreparingRegistryAgent}
              onNavigation={applyWizardNavigation}
            />
          )}
        </WizardHeader>

        {createdInstanceId ? (
          <ProviderWizardAuthenticationStep
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={createdInstanceId}
            onFinish={() => onOpenChange(false)}
          />
        ) : (
          <>
            <WizardPanel className={cn(isAcpRegistry && wizardStep === identityStep && "min-h-72")}>
              <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
                <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
                  {t("settings.providers.instance.provider")}
                </div>
                <ProviderOptionGrid
                  options={featuredDriverOptions}
                  value={driver}
                  disabled={isPreparingRegistryAgent}
                  onValueChange={selectDriver}
                  aria-labelledby="add-instance-driver-label"
                />
                <MultipleAccountsNote environmentId={environmentId} driver={driver} />
              </div>

              {wizardStep === 0 && (moreDriverOptions.length > 0 || acpRegistryAllowed) ? (
                <Collapsible open={showMoreProviders} onOpenChange={setShowMoreProviders}>
                  <div className="flex pt-2">
                    <CollapsibleTrigger render={<Button variant="ghost-muted" size="xs" />}>
                      {showMoreProviders
                        ? t("settings.providers.instance.showLess")
                        : t("settings.providers.instance.showMore")}
                      <ChevronDownIcon
                        aria-hidden
                        className={cn("transition-transform", showMoreProviders && "rotate-180")}
                      />
                    </CollapsibleTrigger>
                  </div>
                  {/* WizardPanel already animates its height, so the fold opens without its own. */}
                  <CollapsiblePanel animate={false}>
                    <div className="space-y-4 pt-4">
                      <ProviderOptionGrid
                        options={moreDriverOptions}
                        value={driver}
                        disabled={isPreparingRegistryAgent}
                        onValueChange={selectDriver}
                        aria-label={t("settings.providers.instance.moreProviders")}
                      />
                      {!acpRegistryAllowed ? null : (
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <div aria-hidden className="flex-1 border-t border-border/70" />
                          <span>{t("settings.providers.instance.orRegistry")}</span>
                          <div aria-hidden className="flex-1 border-t border-border/70" />
                        </div>
                      )}
                      {!acpRegistryAllowed ? null : isAcpRegistry && isManualAcpConfiguration ? (
                        <div className="grid gap-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <h3 className="text-sm font-medium text-foreground">
                                {isLocalAcp
                                  ? t("settings.providers.acp.localCommand")
                                  : t("settings.providers.acp.enterManually")}
                              </h3>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {isLocalAcp
                                  ? t("settings.providers.instance.localCommandDescription", {
                                      environment: String(environmentLabel),
                                    })
                                  : t("settings.providers.instance.manualDescription")}
                              </p>
                            </div>
                            <Button
                              onClick={() => {
                                setIsManualAcpConfiguration(false);
                                setHasAttemptedSubmit(false);
                              }}
                              size="xs"
                              variant="ghost"
                            >
                              {t("settings.providers.instance.searchRegistry")}
                            </Button>
                          </div>
                          <SettingsGroup variant="plain">
                            <ProviderSettingsForm
                              definition={driverOption}
                              value={configDraft}
                              idPrefix="add-provider-acpRegistry-manual"
                              variant="settings"
                              onChange={setConfigDraft}
                              environmentId={environmentId}
                            />
                            {isLocalAcp ? (
                              <ProviderEnvironmentSection
                                environment={localEnvironment}
                                onChange={setLocalEnvironment}
                                secretSources={secretSources}
                              />
                            ) : null}
                          </SettingsGroup>
                          {isAcpRegistry && hasAttemptedSubmit && acpSelectionError ? (
                            <p className="text-2xs text-destructive">{acpSelectionError}</p>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          <AcpRegistrySearchStep
                            environmentId={environmentId}
                            registry={registry}
                            providerInstances={settings.providerInstances}
                            onPrepared={handleAcpPrepared}
                            onManualConfiguration={handleManualAcpConfiguration}
                            onLocalConfiguration={handleLocalAcpConfiguration}
                          />
                          {isAcpRegistry && hasAttemptedSubmit && acpSelectionError ? (
                            <p className="mt-2 text-2xs text-destructive">{acpSelectionError}</p>
                          ) : null}
                        </>
                      )}
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              ) : null}

              {isAcpRegistry && wizardStep === 1 && selectedAcp ? (
                <div className="mb-4 flex items-start justify-between gap-3 border-b border-border/70 pb-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {selectedAcp.name}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      v{selectedAcp.version} · {selectedAcp.distribution}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2 text-2xs">
                    {selectedAcp.website ? (
                      <a
                        aria-label={t("settings.providers.instance.openDocs", {
                          name: String(selectedAcp.name),
                          id: String(selectedAcp.id),
                        })}
                        className="text-muted-foreground hover:text-foreground"
                        href={selectedAcp.website}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {t("settings.providers.instance.docs")}
                      </a>
                    ) : null}
                    {selectedAcp.repository ? (
                      <a
                        aria-label={t("settings.providers.instance.openSource", {
                          name: String(selectedAcp.name),
                          id: String(selectedAcp.id),
                        })}
                        className="text-muted-foreground hover:text-foreground"
                        href={selectedAcp.repository}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {t("settings.providers.instance.source")}
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <SettingsGroup
                variant="plain"
                className={cn(wizardStep !== identityStep && "hidden")}
              >
                <SettingsRow
                  title={
                    <label htmlFor="add-provider-label">
                      {t("settings.providers.instance.label")}
                    </label>
                  }
                  description={
                    <span id="add-provider-label-description">
                      {t("settings.providers.instance.labelDescription")}
                    </span>
                  }
                  control={
                    <Input
                      id="add-provider-label"
                      aria-describedby="add-provider-label-description"
                      size="sm"
                      className="w-full @min-[32rem]/settings-row:w-56"
                      placeholder={t("settings.providers.instance.labelPlaceholder")}
                      value={label}
                      onChange={(event) => setIdentityDraft({ label: event.target.value })}
                    />
                  }
                />
                <SettingsRow
                  title={
                    <label htmlFor="add-provider-instance-id">
                      {t("settings.providers.instance.id")}
                    </label>
                  }
                  description={
                    <span id="add-provider-instance-id-description">
                      {t("settings.providers.instance.idDescription")}
                    </span>
                  }
                  status={
                    showInstanceIdError ? (
                      <span
                        id="add-provider-instance-id-error"
                        role="alert"
                        className="text-destructive"
                      >
                        {instanceIdError}
                      </span>
                    ) : undefined
                  }
                  control={
                    <Input
                      id="add-provider-instance-id"
                      aria-describedby={
                        showInstanceIdError
                          ? "add-provider-instance-id-description add-provider-instance-id-error"
                          : "add-provider-instance-id-description"
                      }
                      size="sm"
                      className="w-full @min-[32rem]/settings-row:w-56"
                      placeholder={`${driver}_work`}
                      value={instanceId}
                      onChange={(event) => {
                        setIdentityDraft({ instanceIdOverride: event.target.value });
                      }}
                      aria-invalid={showInstanceIdError}
                    />
                  }
                />
                <SettingsRow
                  title={t("settings.providers.instance.accent")}
                  description={t("settings.providers.instance.accentDescription")}
                  control={
                    <ProviderAccentColorPicker
                      displayName={label || driverOption.label}
                      value={accentColor || undefined}
                      onCommit={(value) => setIdentityDraft({ accentColor: value })}
                      layout="inline"
                    />
                  }
                />
              </SettingsGroup>

              {!isAcpRegistry && driverSettingsFields.length > 0 ? (
                <SettingsGroup variant="plain" className={cn(wizardStep !== 2 && "hidden")}>
                  <ProviderSettingsForm
                    definition={driverOption}
                    value={configDraft}
                    idPrefix={`add-provider-${driver}`}
                    variant="settings"
                    onChange={setConfigDraft}
                    managed={
                      driverLocks && { keys: driverLocks.configKeys, reason: driverLocks.reason }
                    }
                    environmentId={environmentId}
                  />
                </SettingsGroup>
              ) : !isAcpRegistry && wizardStep === 2 ? (
                <div className="grid gap-2">
                  <p className="text-sm text-muted-foreground">
                    {t("settings.providers.instance.noConfig")}
                  </p>
                </div>
              ) : null}
            </WizardPanel>

            <WizardFooter>
              <Button
                variant={wizardStep === 0 ? "ghost-muted" : "outline"}
                size="sm"
                disabled={isSaving || isPreparingRegistryAgent}
                onClick={() => {
                  if (wizardStep === 0) {
                    onOpenChange(false);
                    return;
                  }
                  setWizardStep((step) => Math.max(0, step - 1));
                }}
              >
                {wizardStep === 0
                  ? t("settings.providers.instance.cancel")
                  : t("settings.providers.instance.back")}
              </Button>
              {wizardStep === 0 && driver === "codex" ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => navigateToStep(1)}>
                    {t("settings.providers.instance.configureManually")}
                  </Button>
                  {driverLocks?.configKeys.has("setupMode") ? null : (
                    <ChatGptConnectionButton
                      size="sm"
                      onClick={() => setAddingChatGptAccount(true)}
                    />
                  )}
                </>
              ) : wizardStep < (isAcpRegistry ? 1 : 2) ? (
                <Button
                  size="sm"
                  disabled={isPreparingRegistryAgent}
                  onClick={() => navigateToStep(wizardStep + 1)}
                >
                  {t("settings.providers.instance.next")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={isSaving || !canManageProviders}
                  onClick={() => void handleSave()}
                >
                  {isSaving
                    ? t("settings.providers.instance.adding")
                    : isAcpRegistry && !isLocalAcp
                      ? t("settings.providers.instance.continueSignIn")
                      : t("settings.providers.instance.addInstance")}
                </Button>
              )}
            </WizardFooter>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}
