import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import {
  CheckIcon,
  ChevronDownIcon,
  HardDriveIcon,
  MessageCircleIcon,
  TerminalIcon,
} from "lucide-react";
import { useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
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
  TRAEX_BRIDGE_CODEX_LAUNCH_ARGS,
  LOCAL_ACP_WIZARD_STEPS,
  deriveAvailableInstanceId,
  validateInstanceId,
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

/** Limit the slug to 48 chars so the composed ProviderInstanceId fits its 64-char cap. */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function deriveInstanceId(driver: ProviderDriverKind, label: string): string {
  const slug = slugifyLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const TRAEX_BRIDGE_PRESET = "traexBridge";
const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const DEFAULT_DRIVER_OPTION = providerClients.definitions[0]!;
const PROVIDER_OPTIONS = [
  ...providerClients.definitions
    .filter((option) => option.driverKind !== ACP_REGISTRY_DRIVER_KIND)
    .map((option) => ({ ...option, value: option.driverKind })),
  { ...DEFAULT_DRIVER_OPTION, value: TRAEX_BRIDGE_PRESET, label: "Traex" },
];
const FEATURED_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => option.featured !== false);
const MORE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => option.featured === false);

function ProviderOptionGrid({
  options,
  value,
  disabled,
  onValueChange,
  ...labelProps
}: {
  readonly options: ReadonlyArray<(typeof PROVIDER_OPTIONS)[number]>;
  readonly value: string;
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
          key={option.value}
          value={option.value}
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
type ConnectionChoice = "cli" | "existing" | "managed";
const CODEX_CONNECTION_OPTIONS = [
  {
    value: "cli",
    label: "Sign in with Codex CLI",
    description: "Add an account that shares your Codex skills, plugins, and history.",
    icon: TerminalIcon,
  },
  {
    value: "existing",
    label: "Use existing Codex CLI",
    description: "Use the CLI account and settings on this environment.",
    icon: HardDriveIcon,
  },
  {
    value: "managed",
    label: "Use ChatGPT sharing",
    description: "Use your ChatGPT plan. Some Codex features are unavailable.",
    icon: MessageCircleIcon,
  },
] as const;
const CONNECTION_OPTIONS = {
  codex: CODEX_CONNECTION_OPTIONS,
  claudeAgent: [
    {
      value: "cli",
      label: "Sign in with Claude Code",
      description:
        "Add an account with its own login and history that shares your Claude settings, skills, and plugins.",
      icon: TerminalIcon,
    },
    {
      value: "existing",
      label: "Use existing Claude Code",
      description: "Use the CLI account and settings on this environment.",
      icon: HardDriveIcon,
    },
  ],
} as const;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated?: (instanceId: ProviderInstanceId) => void;
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  onOpenChange,
  onCreated,
}: AddProviderInstanceDialogProps) {
  const settings = useEnvironmentSettings(environmentId);
  const secretSources = useSecretSources(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);

  const [wizardStep, setWizardStep] = useState(0);
  const managedPolicy = useManagedPolicy(environmentId);
  const featuredProviderOptions = FEATURED_PROVIDER_OPTIONS.filter((option) =>
    isManagedDriverAllowed(managedPolicy, option.driverKind),
  );
  const moreProviderOptions = MORE_PROVIDER_OPTIONS.filter((option) =>
    isManagedDriverAllowed(managedPolicy, option.driverKind),
  );
  const acpRegistryAllowed = isManagedDriverAllowed(managedPolicy, ACP_REGISTRY_DRIVER_KIND);
  const [providerView, setProviderView] = useState<"catalog" | "connection" | "managed">("catalog");
  const [connectionChoices, setConnectionChoices] = useState<
    Partial<Record<string, ConnectionChoice>>
  >({});
  const [selection, setSelection] = useState<string>(
    () =>
      (featuredProviderOptions[0] ?? moreProviderOptions[0])?.value ??
      (acpRegistryAllowed ? ACP_REGISTRY_DRIVER_KIND : DEFAULT_DRIVER_KIND),
  );
  const [showMoreProviders, setShowMoreProviders] = useState(false);
  const driver =
    selection === TRAEX_BRIDGE_PRESET ? DEFAULT_DRIVER_KIND : ProviderDriverKind.make(selection);
  const [identityByDriver, setIdentityByDriver] = useState<Record<string, ProviderIdentityDraft>>(
    {},
  );
  const [selectedAcp, setSelectedAcp] = useState<AcpRegistrySearchAgent | null>(null);
  const [localEnvironment, setLocalEnvironment] = useState<
    ReadonlyArray<ProviderInstanceEnvironmentVariable>
  >([]);
  const [isManualAcpConfiguration, setIsManualAcpConfiguration] = useState(false);
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
  const hasConnectionChoice = selection === "codex" || selection === "claudeAgent";
  const connectionChoice = connectionChoices[selection] ?? "cli";
  const connectionOptions =
    selection === "claudeAgent" ? CONNECTION_OPTIONS.claudeAgent : CONNECTION_OPTIONS.codex;
  const isCliAccount = hasConnectionChoice && connectionChoice === "cli";
  const showRegistrySearch =
    !createdInstanceId &&
    providerView === "catalog" &&
    wizardStep === 0 &&
    showMoreProviders &&
    !(isAcpRegistry && isManualAcpConfiguration);
  const registry = useAcpRegistrySearch(environmentId, showRegistrySearch);
  const isPreparingRegistryAgent = registry.preparingId !== null;
  const defaultIdentity: ProviderIdentityDraft = {
    label: selection === TRAEX_BRIDGE_PRESET ? "Traex" : driverOption.label,
    accentColor: "",
    instanceIdOverride: null,
  };
  const { label, accentColor, instanceIdOverride } = identityByDriver[selection] ?? defaultIdentity;
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
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const identityStep = 1;
  const previewLabel = label.trim() || `${driverOption.label} Workspace`;

  const storedConfigDraft = configByDriver[selection] ?? EMPTY_CONFIG_DRAFT;
  const defaultTraexHomePath = `~/.codex-t3/traex/${instanceId}`;
  const configDraft =
    selection === TRAEX_BRIDGE_PRESET
      ? {
          homePath: defaultTraexHomePath,
          launchArgs: TRAEX_BRIDGE_CODEX_LAUNCH_ARGS,
          ...storedConfigDraft,
        }
      : storedConfigDraft;
  const isLocalAcp = isAcpRegistry && isManualAcpConfiguration && configDraft.source === "local";
  const localCommandPath =
    typeof configDraft.commandPath === "string" ? configDraft.commandPath.trim() : "";
  const manualAgentId = typeof configDraft.agentId === "string" ? configDraft.agentId.trim() : "";
  const acpSelectionError = isLocalAcp
    ? localCommandPath.length > 0
      ? null
      : "Executable is required."
    : selectedAcp !== null || (isManualAcpConfiguration && manualAgentId.length > 0)
      ? null
      : "Select an ACP or configure one manually.";
  const wizardStepSummaries = isAcpRegistry
    ? ([
        isLocalAcp ? "Local ACP command" : (selectedAcp?.name ?? (manualAgentId || null)),
        previewLabel,
        null,
      ] as const)
    : ([
        selection === TRAEX_BRIDGE_PRESET ? "Traex" : driverOption.label,
        previewLabel,
        null,
      ] as const);
  const setConfigDraft = (config: Record<string, unknown> | undefined) => {
    const overrides = { ...config };
    if (selection === TRAEX_BRIDGE_PRESET && overrides.homePath === defaultTraexHomePath) {
      delete overrides.homePath;
    }
    setConfigByDriver((existing) => {
      const next = { ...existing };
      if (Object.keys(overrides).length === 0) {
        delete next[selection];
      } else {
        next[selection] = overrides;
      }
      return next;
    });
  };
  const setIdentityDraft = (update: Partial<ProviderIdentityDraft>) => {
    setIdentityByDriver((existing) => ({
      ...existing,
      [selection]: { ...(existing[selection] ?? defaultIdentity), ...update },
    }));
  };
  const selectProvider = (value: string) => {
    setSelection(value);
    setIsManualAcpConfiguration(false);
    setHasAttemptedSubmit(false);
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (isSaving || isPreparingRegistryAgent || createdInstanceId) return;
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    if (
      ((isAcpRegistry && !isLocalAcp) || isCliAccount) &&
      navigation.kind === "navigate" &&
      navigation.step === 2
    ) {
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
    setSelection(ACP_REGISTRY_DRIVER_KIND);
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
    setSelection(ACP_REGISTRY_DRIVER_KIND);
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
    setSelection(ACP_REGISTRY_DRIVER_KIND);
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

    const config = isCliAccount
      ? { setupMode: "cli" }
      : driver === "codex" || driver === "claudeAgent"
        ? { ...configDraft, setupMode: "existing" }
        : configDraft;
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
        title: "Could not add provider instance",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
      return;
    }
    onCreated?.(brandedId);
    if ((isAcpRegistry && !isLocalAcp) || isCliAccount) {
      setCreatedInstanceId(brandedId);
      setIsSaving(false);
      setWizardStep(2);
      return;
    }
    toastManager.add({
      type: "success",
      title: "Provider instance added",
      description: `${driverOption.label} instance '${instanceId}' was added.`,
    });
    onOpenChange(false);
  };

  if (providerView === "managed") {
    return (
      <AddManagedCodexAccountDialog
        environmentId={environmentId}
        onClose={() => onOpenChange(false)}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WizardPopup size={providerView === "connection" ? "default" : "wide"}>
        <WizardHeader
          title={providerView === "connection" ? `Connect ${driverOption.label}` : "Add provider"}
          description={
            providerView === "connection" ? (
              <>
                Choose how {driverOption.label} connects to {environmentLabel}.
              </>
            ) : (
              <>Add an account or configure a provider on {environmentLabel}.</>
            )
          }
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
              disabled={
                isSaving ||
                isPreparingRegistryAgent ||
                createdInstanceId !== null ||
                (hasConnectionChoice && wizardStep === 0)
              }
              steps={
                (providerView === "connection" ? connectionChoice === "cli" : isCliAccount)
                  ? ACP_REGISTRY_WIZARD_STEPS
                  : ADD_PROVIDER_WIZARD_STEPS
              }
              onNavigation={applyWizardNavigation}
            />
          )}
        </WizardHeader>

        {createdInstanceId ? (
          <ProviderWizardAuthenticationStep
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={createdInstanceId}
            autoOpenBrowser={isCliAccount}
            onFinish={() => onOpenChange(false)}
          />
        ) : (
          <>
            <WizardPanel className={cn(isAcpRegistry && wizardStep === identityStep && "min-h-72")}>
              <div
                className={cn(
                  "grid gap-2",
                  (wizardStep !== 0 || providerView !== "catalog") && "hidden",
                )}
              >
                <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
                  Provider
                </div>
                <ProviderOptionGrid
                  options={featuredProviderOptions}
                  disabled={isPreparingRegistryAgent}
                  value={selection}
                  onValueChange={selectProvider}
                  aria-labelledby="add-instance-driver-label"
                />
                <MultipleAccountsNote environmentId={environmentId} driver={driver} />
              </div>

              {wizardStep === 0 && providerView === "connection" ? (
                <div className="grid gap-2">
                  <div
                    id="add-provider-connection-label"
                    className="text-sm font-medium text-foreground"
                  >
                    Connection method
                  </div>
                  <RadioGroup
                    aria-labelledby="add-provider-connection-label"
                    value={connectionChoice}
                    onValueChange={(value) => {
                      if (value === "cli" || value === "existing" || value === "managed") {
                        setConnectionChoices((current) => ({ ...current, [selection]: value }));
                      }
                    }}
                  >
                    {connectionOptions.map((option) => {
                      const Icon = option.icon;
                      return (
                        <RadioPrimitive.Root
                          key={option.value}
                          value={option.value}
                          aria-label={`${option.label}. ${option.description}`}
                          className="flex min-w-0 cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-2.5 text-left outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary"
                        >
                          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">
                              {option.label}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {option.description}
                            </span>
                          </span>
                          <span aria-hidden className="size-4.5 shrink-0">
                            <RadioPrimitive.Indicator className="grid size-4.5 place-items-center rounded-full border border-input bg-background data-checked:border-primary data-checked:bg-primary">
                              {connectionChoice === option.value ? (
                                <span className="size-1.5 rounded-full bg-primary-foreground" />
                              ) : null}
                            </RadioPrimitive.Indicator>
                          </span>
                        </RadioPrimitive.Root>
                      );
                    })}
                  </RadioGroup>
                </div>
              ) : null}

              {wizardStep === 0 &&
              providerView === "catalog" &&
              (moreProviderOptions.length > 0 || acpRegistryAllowed) ? (
                <Collapsible open={showMoreProviders} onOpenChange={setShowMoreProviders}>
                  <div className="flex pt-2">
                    <CollapsibleTrigger render={<Button variant="ghost-muted" size="xs" />}>
                      {showMoreProviders ? "Show less" : "Show more"}
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
                        options={moreProviderOptions}
                        value={selection}
                        disabled={isPreparingRegistryAgent}
                        onValueChange={selectProvider}
                        aria-label="More providers"
                      />
                      {!acpRegistryAllowed ? null : (
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <div aria-hidden className="flex-1 border-t border-border/70" />
                          <span>Or choose from ACP Registry</span>
                          <div aria-hidden className="flex-1 border-t border-border/70" />
                        </div>
                      )}
                      {!acpRegistryAllowed ? null : isAcpRegistry && isManualAcpConfiguration ? (
                        <div className="grid gap-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <h3 className="text-sm font-medium text-foreground">
                                {isLocalAcp ? "Local ACP command" : "Enter manually"}
                              </h3>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {isLocalAcp
                                  ? `Run an installed ACP executable on ${environmentLabel}.`
                                  : "Enter an official registry ID and any local executable or auth override."}
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
                              Search registry
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
                        aria-label={`Open documentation for ${selectedAcp.name} (${selectedAcp.id})`}
                        className="text-muted-foreground hover:text-foreground"
                        href={selectedAcp.website}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Docs
                      </a>
                    ) : null}
                    {selectedAcp.repository ? (
                      <a
                        aria-label={`Open source for ${selectedAcp.name} (${selectedAcp.id})`}
                        className="text-muted-foreground hover:text-foreground"
                        href={selectedAcp.repository}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Source
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
                  title={<label htmlFor="add-provider-label">Label</label>}
                  description={
                    <span id="add-provider-label-description">Shown in the provider list.</span>
                  }
                  control={
                    <Input
                      id="add-provider-label"
                      aria-describedby="add-provider-label-description"
                      size="sm"
                      className="w-full @min-[32rem]/settings-row:w-56"
                      placeholder="e.g. Work"
                      value={label}
                      onChange={(event) => setIdentityDraft({ label: event.target.value })}
                    />
                  }
                />
                <SettingsRow
                  title={<label htmlFor="add-provider-instance-id">Instance ID</label>}
                  description={
                    <span id="add-provider-instance-id-description">
                      Letters, digits, '-', or '_'.
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
                  title="Accent color"
                  description="Optional marker shown in the picker."
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

              {!isAcpRegistry && !isCliAccount && driverSettingsFields.length > 0 ? (
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
              ) : !isAcpRegistry && !isCliAccount && wizardStep === 2 ? (
                <div className="grid gap-2">
                  <p className="text-sm text-muted-foreground">
                    This driver has no required configuration. You can add the instance now.
                  </p>
                </div>
              ) : null}
            </WizardPanel>

            <WizardFooter>
              <Button
                variant={wizardStep === 0 && providerView === "catalog" ? "ghost-muted" : "outline"}
                size="sm"
                disabled={isSaving || isPreparingRegistryAgent}
                onClick={() => {
                  if (wizardStep === 0) {
                    if (providerView === "connection") {
                      setProviderView("catalog");
                      return;
                    }
                    onOpenChange(false);
                    return;
                  }
                  setWizardStep((step) => Math.max(0, step - 1));
                }}
              >
                {wizardStep === 0 && providerView === "catalog" ? "Cancel" : "Back"}
              </Button>
              {wizardStep === 0 ? (
                <Button
                  size="sm"
                  disabled={isPreparingRegistryAgent}
                  onClick={() => {
                    if (providerView === "connection") {
                      if (connectionChoice === "managed") setProviderView("managed");
                      else setWizardStep(1);
                      return;
                    }
                    if (hasConnectionChoice) {
                      setProviderView("connection");
                      return;
                    }
                    navigateToStep(wizardStep + 1);
                  }}
                >
                  {providerView === "connection" ? "Continue" : "Next"}
                </Button>
              ) : wizardStep < (isAcpRegistry || isCliAccount ? 1 : 2) ? (
                <Button
                  size="sm"
                  disabled={isPreparingRegistryAgent}
                  onClick={() => navigateToStep(wizardStep + 1)}
                >
                  Next
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={isSaving || !canManageProviders}
                  onClick={() => void handleSave()}
                >
                  {isSaving
                    ? "Adding..."
                    : (isAcpRegistry && !isLocalAcp) || isCliAccount
                      ? "Continue to sign-in"
                      : "Add instance"}
                </Button>
              )}
            </WizardFooter>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}
