"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type AcpRegistrySearchAgent,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Gemini, GithubCopilotIcon, PiAgentIcon, type Icon } from "../Icons";
import { Dialog } from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { WizardPanel, WizardPopup, WizardHeader, WizardFooter } from "../ui/wizard";
import {
  ACP_REGISTRY_WIZARD_STEPS,
  ADD_PROVIDER_WIZARD_STEPS,
  deriveAvailableInstanceId,
  getProviderIdentityDraft,
  resolveAcpRegistryWizardNavigation,
  resolveWizardNavigation,
  updateProviderIdentityDraft,
  type ProviderIdentityDraft,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { AcpRegistrySearchStep } from "./AcpRegistrySearchStep";
import { resolveOfficialAcpRegistryIconUrl } from "./AcpRegistryIcon";
import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

/**
 * Normalize a user-provided label into a slug suffix for the instance id.
 * The full id is formed by prefixing the driver slug — e.g. label "Work" on
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
interface ComingSoonDriverOption {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
}

const COMING_SOON_DRIVER_OPTIONS: readonly ComingSoonDriverOption[] = [
  {
    value: ProviderDriverKind.make("githubCopilot"),
    label: "Github Copilot",
    icon: GithubCopilotIcon,
  },
  {
    value: ProviderDriverKind.make("gemini"),
    label: "Gemini",
    icon: Gemini,
  },
  {
    value: ProviderDriverKind.make("piAgent"),
    label: "Pi Agent",
    icon: PiAgentIcon,
  },
];

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
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  // ACP Registry instances go straight to sign-in, which needs the saved
  // instance, so their save is awaited instead of fire-and-forget.
  const persistSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

  const [wizardStep, setWizardStep] = useState(0);
  const [driver, setDriver] = useState<ProviderDriverKind>(DEFAULT_DRIVER_KIND);
  const [identityByDriver, setIdentityByDriver] = useState<Record<string, ProviderIdentityDraft>>(
    {},
  );
  const [selectedAcp, setSelectedAcp] = useState<AcpRegistrySearchAgent | null>(null);
  const [isManualAcpConfiguration, setIsManualAcpConfiguration] = useState(false);
  const [isRegistryLoading, setIsRegistryLoading] = useState(false);
  const [isPreparingRegistryAgent, setIsPreparingRegistryAgent] = useState(false);
  // Driver-specific config drafts keyed by driver so toggling between drivers
  // during the same dialog session does not lose in-progress input.
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [createdInstanceId, setCreatedInstanceId] = useState<ProviderInstanceId | null>(null);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
  const isAcpRegistry = driver === ACP_REGISTRY_DRIVER_KIND;
  const { label, accentColor, instanceIdOverride } = getProviderIdentityDraft(
    identityByDriver,
    driver,
  );
  const instanceId = instanceIdOverride ?? deriveInstanceId(driver, label);
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const previewLabel = label.trim() || `${driverOption.label} Workspace`;

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const manualAgentId = typeof configDraft.agentId === "string" ? configDraft.agentId.trim() : "";
  const acpSelectionError =
    selectedAcp !== null || (isManualAcpConfiguration && manualAgentId.length > 0)
      ? null
      : "Select an ACP agent or configure one manually.";
  const wizardStepSummaries = isAcpRegistry
    ? ([selectedAcp?.name ?? (manualAgentId || null), previewLabel, null] as const)
    : ([driverOption.label, previewLabel, null] as const);
  const isBusy = isSaving || isPreparingRegistryAgent || createdInstanceId !== null;

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
    setIdentityByDriver((existing) => updateProviderIdentityDraft(existing, driver, update));
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (isBusy) return;
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    if (isAcpRegistry && navigation.kind === "navigate" && navigation.step === 2) {
      void handleSave();
      return;
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

  /** A prepared registry agent prefills the ACP Registry identity and config. */
  const handleAcpPrepared = (agent: AcpRegistrySearchAgent) => {
    const registryIconUrl = resolveOfficialAcpRegistryIconUrl(agent.icon);
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    setSelectedAcp(agent);
    setIsManualAcpConfiguration(false);
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: agent.name,
        instanceIdOverride: deriveAvailableInstanceId(
          (candidateLabel) => deriveInstanceId(ACP_REGISTRY_DRIVER_KIND, candidateLabel),
          agent.name,
          existingIds,
        ),
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

  const handleSave = async () => {
    if (isSaving || createdInstanceId) return;
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
    const nextMap = {
      ...settings.providerInstances,
      [brandedId]: nextInstance,
    };
    if (isAcpRegistry) {
      setIsSaving(true);
      const result = await persistSettings({
        environmentId,
        input: { patch: { providerInstances: nextMap } },
      });
      setIsSaving(false);
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not add provider instance",
          description: error instanceof Error ? error.message : "The settings update failed.",
        });
        return;
      }
      onCreated?.(brandedId);
      setCreatedInstanceId(brandedId);
      setWizardStep(2);
      return;
    }
    try {
      updateSettings({ providerInstances: nextMap });
      onCreated?.(brandedId);
      toastManager.add({
        type: "success",
        title: "Provider instance added",
        description: `${driverOption.label} instance '${instanceId}' was added.`,
      });
      onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not add provider instance",
        description: error instanceof Error ? error.message : "Update failed.",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WizardPopup>
        <WizardHeader
          title="Add provider instance"
          description={
            <>
              Configure an additional provider instance on {environmentLabel} — for example, a
              second Codex install pointed at a different workspace.
            </>
          }
        >
          {isAcpRegistry ? (
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              steps={ACP_REGISTRY_WIZARD_STEPS}
              identityStep={1}
              prerequisite={{ step: 0, error: acpSelectionError }}
              disabled={isBusy}
              onNavigation={applyWizardNavigation}
            />
          ) : (
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              disabled={isBusy}
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
            <WizardPanel
              holdHeight={wizardStep === 0 && !isManualAcpConfiguration && isRegistryLoading}
            >
              <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
                <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
                  Driver
                </div>
                <RadioGroup
                  disabled={isPreparingRegistryAgent}
                  value={driver}
                  onValueChange={(value) => {
                    setDriver(ProviderDriverKind.make(value));
                    setIsManualAcpConfiguration(false);
                    setHasAttemptedSubmit(false);
                  }}
                  aria-labelledby="add-instance-driver-label"
                  className="grid grid-cols-1 sm:grid-cols-2"
                >
                  {DRIVER_OPTIONS.filter((option) => option.value !== ACP_REGISTRY_DRIVER_KIND).map(
                    (option) => {
                      const IconComponent = option.icon;
                      return (
                        <RadioPrimitive.Root
                          key={option.value}
                          value={option.value}
                          className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
                        >
                          <IconComponent className="size-4 shrink-0" aria-hidden />
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
                    },
                  )}
                  {COMING_SOON_DRIVER_OPTIONS.map((option) => {
                    const IconComponent = option.icon;
                    return (
                      <RadioPrimitive.Root
                        key={option.value}
                        value={option.value}
                        disabled
                        className={cn(
                          "relative flex cursor-not-allowed items-center gap-3 rounded-lg bg-card/60 px-3 py-3 text-left opacity-64 outline-none ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5",
                        )}
                      >
                        <IconComponent
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {option.label}
                        </span>
                        <Badge variant="warning" size="sm">
                          Coming Soon
                        </Badge>
                      </RadioPrimitive.Root>
                    );
                  })}
                </RadioGroup>
              </div>

              {wizardStep === 0 ? (
                <div className="space-y-4 pt-4">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <div aria-hidden className="flex-1 border-t border-border/70" />
                    <span>Or choose from ACP Registry</span>
                    <div aria-hidden className="flex-1 border-t border-border/70" />
                  </div>
                  {isAcpRegistry && isManualAcpConfiguration ? (
                    <div className="grid gap-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-medium text-foreground">Enter manually</h3>
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
                      <ProviderSettingsForm
                        definition={driverOption}
                        value={configDraft}
                        idPrefix="add-provider-acpRegistry-manual"
                        variant="dialog"
                        onChange={setConfigDraft}
                      />
                      {hasAttemptedSubmit && acpSelectionError ? (
                        <p className="text-2xs text-destructive">{acpSelectionError}</p>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <AcpRegistrySearchStep
                        environmentId={environmentId}
                        providerInstances={settings.providerInstances ?? {}}
                        onPrepared={handleAcpPrepared}
                        onManualConfiguration={handleManualAcpConfiguration}
                        onLoadingChange={setIsRegistryLoading}
                        onPreparingChange={setIsPreparingRegistryAgent}
                      />
                      {isAcpRegistry && hasAttemptedSubmit && acpSelectionError ? (
                        <p className="mt-2 text-2xs text-destructive">{acpSelectionError}</p>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

              {isAcpRegistry && wizardStep === 1 && selectedAcp ? (
                <div className="flex items-start justify-between gap-3 border-b border-border/70 pb-3">
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

              <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">Label</span>
                <Input
                  placeholder="e.g. Work"
                  value={label}
                  onChange={(event) => setIdentityDraft({ label: event.target.value })}
                />
                <span className="text-2xs text-muted-foreground">
                  Shown in the provider list. Optional.
                </span>
              </label>

              <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">Instance ID</span>
                <Input
                  placeholder={`${driver}_work`}
                  value={instanceId}
                  onChange={(event) => {
                    setIdentityDraft({ instanceIdOverride: event.target.value });
                  }}
                  aria-invalid={showInstanceIdError}
                />
                {showInstanceIdError ? (
                  <span className="text-2xs text-destructive">{instanceIdError}</span>
                ) : (
                  <span className="text-2xs text-muted-foreground">
                    Routing key used by threads and sessions. Letters, digits, '-', or '_'.
                  </span>
                )}
              </label>

              <div className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">Accent color</span>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <ProviderAccentColorPicker
                    displayName={label || driverOption.label}
                    value={accentColor || undefined}
                    onCommit={(value) => setIdentityDraft({ accentColor: value })}
                    layout="inline"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
                      const selected = accentColor.toLowerCase() === swatch;
                      return (
                        <button
                          key={swatch}
                          type="button"
                          className={cn(
                            "size-6 cursor-pointer rounded-full border transition",
                            selected
                              ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                              : "border-black/10 hover:scale-105 dark:border-white/20",
                          )}
                          style={{ backgroundColor: swatch }}
                          onClick={() => setIdentityDraft({ accentColor: swatch })}
                          aria-label={`Use ${swatch} accent`}
                        />
                      );
                    })}
                  </div>
                  {accentColor ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => setIdentityDraft({ accentColor: "" })}
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
                <span className="text-2xs text-muted-foreground">
                  Optional marker shown in the picker.
                </span>
              </div>

              {!isAcpRegistry && driverSettingsFields.length > 0 ? (
                <div className={cn("grid gap-4", wizardStep !== 2 && "hidden")}>
                  <ProviderSettingsForm
                    definition={driverOption}
                    value={configDraft}
                    idPrefix={`add-provider-${driver}`}
                    variant="dialog"
                    onChange={setConfigDraft}
                  />
                </div>
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
                disabled={isSaving || isPreparingRegistryAgent}
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
              {wizardStep < (isAcpRegistry ? 1 : ADD_PROVIDER_WIZARD_STEPS.length - 1) ? (
                <Button
                  disabled={isPreparingRegistryAgent}
                  onClick={() => navigateToStep(wizardStep + 1)}
                >
                  Next
                </Button>
              ) : (
                <Button disabled={isSaving} onClick={() => void handleSave()}>
                  {isSaving ? "Adding..." : isAcpRegistry ? "Continue to sign-in" : "Add instance"}
                </Button>
              )}
            </WizardFooter>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}
