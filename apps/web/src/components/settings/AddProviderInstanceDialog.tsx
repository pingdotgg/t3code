"use client";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type AcpRegistrySearchAgent,
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import * as Equal from "effect/Equal";

import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { WizardPanel, WizardPopup, WizardHeader, WizardFooter } from "../ui/wizard";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  ACP_REGISTRY_WIZARD_STEPS,
  deriveAvailableInstanceId,
  resolveAcpRegistryWizardNavigation,
  resolveWizardNavigation,
  updateProviderIdentityDraft,
  type ProviderIdentityDraft,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { AcpRegistrySearchStep } from "./AcpRegistrySearchStep";
import { resolveOfficialAcpRegistryIconUrl } from "./AcpRegistryIcon";

/**
 * Normalize a user-provided label into a slug suffix for the instance id.
 * The full id is formed by prefixing the driver slug. For example, label "Work" on
 * driver "codex" becomes `codex_work`. Output is trimmed to 48 chars so the
 * final composed id stays under the 64-char slug cap enforced by
 * `ProviderInstanceId` in `@t3tools/contracts`.
 */
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

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const DEFAULT_DRIVER_OPTION = DRIVER_OPTIONS[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
/**
 * Validate an instance id against the same slug rules the server applies in
 * `ProviderInstanceId` (see `packages/contracts/src/providerInstance.ts`).
 * Returns a user-facing error string, or `null` if valid.
 */
function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  onOpenChange,
}: AddProviderInstanceDialogProps) {
  const settings = useEnvironmentSettings(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);

  const [wizardStep, setWizardStep] = useState(0);
  const [driver, setDriver] = useState<ProviderDriverKind>(DEFAULT_DRIVER_KIND);
  const [identityByDriver, setIdentityByDriver] = useState<Record<string, ProviderIdentityDraft>>(
    {},
  );
  const [selectedAcp, setSelectedAcp] = useState<AcpRegistrySearchAgent | null>(null);
  const [isManualAcpConfiguration, setIsManualAcpConfiguration] = useState(false);
  const [isRegistryLoading, setIsRegistryLoading] = useState(false);
  // Driver-specific config drafts keyed by driver so toggling between drivers
  // during the same dialog session does not lose in-progress input.
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const existingIds = useMemo(() => {
    const ids = new Set(["codex", "claudeAgent", ...Object.keys(settings.providerInstances ?? {})]);
    const defaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<string, unknown>;
    // Reserve configured legacy slots too, so adding an account cannot replace them.
    for (const [kind, config] of Object.entries(settings.providers ?? {})) {
      if (!Equal.equals(config, defaults[kind])) ids.add(kind);
    }
    return ids;
  }, [settings.providerInstances, settings.providers]);

  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
  const isAcpRegistry = driver === ACP_REGISTRY_DRIVER_KIND;
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
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const identityStep = isAcpRegistry ? 2 : 1;
  const previewLabel = label.trim() || `${driverOption.label} Workspace`;

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const manualAgentId = typeof configDraft.agentId === "string" ? configDraft.agentId.trim() : "";
  const acpSelectionError =
    selectedAcp !== null || (isManualAcpConfiguration && manualAgentId.length > 0)
      ? null
      : "Select an ACP or configure one manually.";
  const wizardStepSummaries = isAcpRegistry
    ? ([driverOption.label, selectedAcp?.name ?? (manualAgentId || null), previewLabel] as const)
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
  const setIdentityDraft = (update: Partial<ProviderIdentityDraft>) => {
    setIdentityByDriver((existing) => ({
      ...existing,
      [driver]: { ...(existing[driver] ?? defaultIdentity), ...update },
    }));
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    setWizardStep(navigation.step);
  };

  const navigateToStep = (requestedStep: number) => {
    applyWizardNavigation(
      isAcpRegistry
        ? resolveAcpRegistryWizardNavigation(wizardStep, requestedStep, {
            instanceIdError,
            selectionError: acpSelectionError,
          })
        : resolveWizardNavigation(wizardStep, requestedStep, ADD_PROVIDER_WIZARD_STEPS.length, {
            instanceIdError,
          }),
    );
  };

  const handleAcpPrepared = (agent: AcpRegistrySearchAgent) => {
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
    setWizardStep(2);
  };

  const handleManualAcpConfiguration = () => {
    setSelectedAcp(null);
    setIsManualAcpConfiguration(true);
    setConfigDraft(undefined);
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: "",
        instanceIdOverride: null,
      }),
    );
    setHasAttemptedSubmit(false);
  };

  const handleSave = async () => {
    if (isSaving) return;
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null || (isAcpRegistry && acpSelectionError !== null)) return;

    const config = configByDriver[driver] ?? {};
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(hasConfig ? { config } : {}),
    };
    // `ProviderInstanceId.make` revalidates the slug; we've already checked
    // it via `validateInstanceId`, but going through the brand constructor
    // keeps the type boundary honest and guards against any future drift in
    // the slug rules.
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
    const referenceUrl = selectedAcp?.website ?? selectedAcp?.repository;
    toastManager.add({
      type: "success",
      title: "Provider instance added",
      description: isAcpRegistry
        ? `${selectedAcp?.name ?? manualAgentId} was added. Complete the agent's advertised authentication on the server; T3 Code detects it automatically.`
        : `${driverOption.label} instance '${instanceId}' was added.`,
      ...(referenceUrl
        ? {
            actionProps: {
              children: selectedAcp?.website ? "Agent docs" : "Agent source",
              onClick: () => window.open(referenceUrl, "_blank", "noopener,noreferrer"),
            },
          }
        : {}),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WizardPopup className="max-w-2xl">
        <WizardHeader
          title="Add provider"
          description={<>Set up a provider on {environmentLabel}.</>}
        >
          {isAcpRegistry ? (
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              steps={ACP_REGISTRY_WIZARD_STEPS}
              identityStep={2}
              prerequisite={{ step: 1, error: acpSelectionError }}
              onNavigation={applyWizardNavigation}
            />
          ) : (
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              onNavigation={applyWizardNavigation}
            />
          )}
        </WizardHeader>

        <WizardPanel
          holdHeight={
            isAcpRegistry && wizardStep === 1 && !isManualAcpConfiguration && isRegistryLoading
          }
        >
          <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
            <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
              Driver
            </div>
            <RadioGroup
              value={driver}
              onValueChange={(value) => {
                setDriver(ProviderDriverKind.make(value));
                setHasAttemptedSubmit(false);
              }}
              aria-labelledby="add-instance-driver-label"
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              {DRIVER_OPTIONS.map((option) => {
                return (
                  <RadioPrimitive.Root
                    key={option.value}
                    value={option.value}
                    className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
                  >
                    <ProviderInstanceIcon
                      driverKind={option.value}
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
                );
              })}
            </RadioGroup>
          </div>

          {isAcpRegistry && wizardStep === 1 ? (
            isManualAcpConfiguration ? (
              <div className="grid gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium text-foreground">Configure manually</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Enter an official registry ID and any local executable or auth override.
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
                  />
                </SettingsGroup>
                {hasAttemptedSubmit && acpSelectionError ? (
                  <p className="text-[11px] text-destructive">{acpSelectionError}</p>
                ) : null}
              </div>
            ) : (
              <>
                <AcpRegistrySearchStep
                  environmentId={environmentId}
                  providerInstances={settings.providerInstances}
                  onPrepared={handleAcpPrepared}
                  onManualConfiguration={handleManualAcpConfiguration}
                  onLoadingChange={setIsRegistryLoading}
                />
                {hasAttemptedSubmit && acpSelectionError ? (
                  <p className="mt-2 text-[11px] text-destructive">{acpSelectionError}</p>
                ) : null}
              </>
            )
          ) : null}

          {isAcpRegistry && wizardStep === 2 && selectedAcp ? (
            <div className="mb-4 flex items-start justify-between gap-3 border-b border-border/70 pb-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{selectedAcp.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  v{selectedAcp.version} · {selectedAcp.distribution}
                </p>
              </div>
              <div className="flex shrink-0 gap-2 text-[11px]">
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

          <SettingsGroup variant="plain" className={cn(wizardStep !== identityStep && "hidden")}>
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
                <span id="add-provider-instance-id-description">Letters, digits, '-', or '_'.</span>
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

          {!isAcpRegistry && driverSettingsFields.length > 0 ? (
            <SettingsGroup variant="plain" className={cn(wizardStep !== 2 && "hidden")}>
              <ProviderSettingsForm
                definition={driverOption}
                value={configDraft}
                idPrefix={`add-provider-${driver}`}
                variant="settings"
                onChange={setConfigDraft}
              />
            </SettingsGroup>
          ) : !isAcpRegistry && wizardStep === 2 ? (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">
                This driver has no required configuration. You can add the instance now.
              </p>
            </div>
          ) : null}
        </WizardPanel>

        <WizardFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={isSaving}
            onClick={() => {
              if (wizardStep === 0) {
                onOpenChange(false);
                return;
              }
              setWizardStep((step) => Math.max(0, step - 1));
            }}
          >
            {wizardStep === 0 ? "Cancel" : "Back"}
          </Button>
          {isAcpRegistry &&
          wizardStep === 1 &&
          !isManualAcpConfiguration &&
          !selectedAcp ? null : wizardStep <
            (isAcpRegistry ? ACP_REGISTRY_WIZARD_STEPS : ADD_PROVIDER_WIZARD_STEPS).length - 1 ? (
            <Button size="sm" onClick={() => navigateToStep(wizardStep + 1)}>
              Next
            </Button>
          ) : (
            <Button size="sm" disabled={isSaving} onClick={() => void handleSave()}>
              {isSaving ? "Adding..." : "Add instance"}
            </Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
