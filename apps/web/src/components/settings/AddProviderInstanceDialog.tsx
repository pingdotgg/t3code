"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ACP_FEATURED_AGENTS,
  type AcpRegistryCatalogIconKey,
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Button } from "../ui/button";
import { ACPRegistryIcon, Gemini, GithubCopilotIcon, PiAgentIcon, type Icon } from "../Icons";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { DRIVER_OPTION_BY_VALUE, NATIVE_DRIVER_OPTIONS } from "./providerDriverMeta";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { AnimatedHeight } from "../AnimatedHeight";
import {
  ACP_REGISTRY_DRIVER,
  ADD_PROVIDER_WIZARD_STEPS,
  acpPickerValue,
  configDraftForFeaturedAgent,
  parseAddProviderPickerValue,
  resolveWizardNavigation,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";

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
const DEFAULT_DRIVER_OPTION = NATIVE_DRIVER_OPTIONS[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};

function iconForCatalogKey(iconKey: AcpRegistryCatalogIconKey): Icon {
  if (iconKey === "gemini") return Gemini;
  if (iconKey === "githubCopilot") return GithubCopilotIcon;
  if (iconKey === "piAgent") return PiAgentIcon;
  return ACPRegistryIcon;
}

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
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  const [wizardStep, setWizardStep] = useState(0);
  const [driver, setDriver] = useState<ProviderDriverKind>(DEFAULT_DRIVER_KIND);
  const [catalogId, setCatalogId] = useState<string | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [accentColor, setAccentColor] = useState<string>("");
  const [instanceIdOverride, setInstanceIdOverride] = useState<string | null>(null);
  // Driver-specific config drafts keyed by driver so toggling between drivers
  // during the same dialog session does not lose in-progress input.
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
  const featuredAgent = catalogId
    ? ACP_FEATURED_AGENTS.find((agent) => agent.id === catalogId)
    : undefined;
  const pickerLabel = featuredAgent?.label ?? driverOption.label;
  const instanceId = instanceIdOverride ?? deriveInstanceId(driver, label);
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const previewLabel = label.trim() || `${pickerLabel} Workspace`;
  const wizardStepSummaries = [pickerLabel, previewLabel, null] as const;
  const pickerValue = catalogId ? acpPickerValue(catalogId) : driver;

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
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

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    setWizardStep(navigation.step);
  };

  const navigateToStep = (requestedStep: number) => {
    applyWizardNavigation(
      resolveWizardNavigation(wizardStep, requestedStep, ADD_PROVIDER_WIZARD_STEPS.length, {
        instanceIdError,
      }),
    );
  };

  const handleSave = () => {
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null) return;

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
    try {
      updateSettings({ providerInstances: nextMap });
      toastManager.add({
        type: "success",
        title: "Provider instance added",
        description: `${pickerLabel} instance '${instanceId}' was added.`,
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
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Add provider instance</DialogTitle>
            <DialogDescription>
              Configure an additional provider instance on {environmentLabel} — native drivers, or
              any ACP-speaking CLI such as Gemini, Copilot, or Pi.
            </DialogDescription>
            <AddProviderInstanceWizardSteps
              currentStep={wizardStep}
              summaries={wizardStepSummaries}
              instanceIdError={instanceIdError}
              onNavigation={applyWizardNavigation}
            />
          </DialogHeader>

          <div
            data-slot="dialog-panel"
            className="space-y-4 bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5"
          >
            <AnimatedHeight>
              <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
                <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
                  Driver
                </div>
                <RadioGroup
                  value={pickerValue}
                  onValueChange={(value) => {
                    const parsed = parseAddProviderPickerValue(value);
                    setDriver(parsed.driver);
                    setCatalogId(parsed.catalogId);
                    if (parsed.catalogId) {
                      const agent = ACP_FEATURED_AGENTS.find(
                        (entry) => entry.id === parsed.catalogId,
                      );
                      setLabel(agent?.label ?? "");
                      const nextConfig = configDraftForFeaturedAgent(parsed.catalogId);
                      setConfigByDriver((existing) => {
                        const next = { ...existing };
                        if (Object.keys(nextConfig).length === 0) {
                          delete next[parsed.driver];
                        } else {
                          next[parsed.driver] = nextConfig;
                        }
                        return next;
                      });
                      return;
                    }
                    if (parsed.driver !== ACP_REGISTRY_DRIVER) {
                      setLabel("");
                    }
                  }}
                  aria-labelledby="add-instance-driver-label"
                  className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                >
                  {NATIVE_DRIVER_OPTIONS.map((option) => {
                    const IconComponent = option.icon;
                    return (
                      <RadioPrimitive.Root
                        key={option.value}
                        value={option.value}
                        className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
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
                  })}
                  {ACP_FEATURED_AGENTS.map((agent) => {
                    const IconComponent = iconForCatalogKey(agent.iconKey);
                    return (
                      <RadioPrimitive.Root
                        key={agent.id}
                        value={acpPickerValue(agent.id)}
                        className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
                      >
                        <IconComponent className="size-4 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {agent.label}
                        </span>
                        <RadioPrimitive.Indicator
                          className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                          aria-hidden
                        >
                          <CheckIcon className="size-3.5 shrink-0" />
                        </RadioPrimitive.Indicator>
                        <Badge variant="warning" size="sm">
                          ACP
                        </Badge>
                      </RadioPrimitive.Root>
                    );
                  })}
                </RadioGroup>
              </div>

              <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">Label</span>
                <Input
                  className="bg-background"
                  placeholder="e.g. Work"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
                <span className="text-[11px] text-muted-foreground">
                  Shown in the provider list. Optional.
                </span>
              </label>

              <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">Instance ID</span>
                <Input
                  className="bg-background"
                  placeholder={`${driver}_work`}
                  value={instanceId}
                  onChange={(event) => {
                    setInstanceIdOverride(event.target.value);
                  }}
                  aria-invalid={showInstanceIdError}
                />
                {showInstanceIdError ? (
                  <span className="text-[11px] text-destructive">{instanceIdError}</span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">
                    Routing key used by threads and sessions. Letters, digits, '-', or '_'.
                  </span>
                )}
              </label>

              <div className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                <span className="text-xs font-medium text-foreground">Accent color</span>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <input
                    type="color"
                    value={normalizeProviderAccentColor(accentColor) ?? PROVIDER_ACCENT_SWATCHES[0]}
                    onChange={(event) => setAccentColor(event.target.value)}
                    aria-label="Provider instance accent color"
                    className="h-8 w-10 cursor-pointer rounded-xl border border-input bg-background p-0.5"
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
                          onClick={() => setAccentColor(swatch)}
                          aria-label={`Use ${swatch} accent`}
                        />
                      );
                    })}
                  </div>
                  {accentColor ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      onClick={() => setAccentColor("")}
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  Optional marker shown in the picker.
                </span>
              </div>

              {driverSettingsFields.length > 0 ? (
                <div className={cn("grid gap-4", wizardStep !== 2 && "hidden")}>
                  <ProviderSettingsForm
                    definition={driverOption}
                    value={configDraft}
                    idPrefix={`add-provider-${driver}`}
                    variant="dialog"
                    onChange={setConfigDraft}
                  />
                </div>
              ) : wizardStep === 2 ? (
                <div className="grid gap-2">
                  <p className="text-sm text-muted-foreground">
                    This driver has no required configuration. You can add the instance now.
                  </p>
                </div>
              ) : null}
            </AnimatedHeight>
          </div>

          <DialogFooter variant="bare">
            <Button
              variant="outline"
              size="sm"
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
            {wizardStep < ADD_PROVIDER_WIZARD_STEPS.length - 1 ? (
              <Button size="sm" onClick={() => navigateToStep(wizardStep + 1)}>
                Next
              </Button>
            ) : (
              <Button size="sm" onClick={handleSave}>
                Add instance
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
