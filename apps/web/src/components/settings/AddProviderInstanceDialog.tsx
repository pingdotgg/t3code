"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon, CopyIcon, LoaderIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  type HermesGatewayEnrollmentResult,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { cn, randomUUID } from "../../lib/utils";
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
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { AnimatedHeight } from "../AnimatedHeight";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  createHermesProviderInstanceId,
  isHermesInstanceRemovedError,
  isOwnedHermesEnrollmentRetry,
  resolveWizardNavigation,
  type WizardNavigation,
  validateProviderInstanceIdForWizard,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  defaultHermesConnectorUrl,
  formatHermesLastConnected,
  messageFromUnknownError,
} from "./HermesGatewayInstanceSection.logic";

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
 * driver "codex" becomes `codex_work`. Hermes uses a random durable identity
 * instead because its historical thread bindings must never target a newly
 * created gateway with the same display name.
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

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
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
    value: ProviderDriverKind.make("acpRegistry"),
    label: "ACP Registry",
    icon: ACPRegistryIcon,
  },
  {
    value: ProviderDriverKind.make("piAgent"),
    label: "Pi Agent",
    icon: PiAgentIcon,
  },
];

interface AddProviderInstanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddProviderInstanceDialog({ open, onOpenChange }: AddProviderInstanceDialogProps) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const updateServerSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const createHermesEnrollment = useAtomCommand(serverEnvironment.hermesGatewayCreateEnrollment, {
    reportFailure: false,
  });

  const [wizardStep, setWizardStep] = useState(0);
  const [driver, setDriver] = useState<ProviderDriverKind>(DEFAULT_DRIVER_KIND);
  const [label, setLabel] = useState("");
  const [accentColor, setAccentColor] = useState<string>("");
  const [instanceIdOverride, setInstanceIdOverride] = useState<string | null>(null);
  const [hermesIdentityNonce, setHermesIdentityNonce] = useState(randomUUID);
  // Driver-specific config drafts keyed by driver so toggling between drivers
  // during the same dialog session does not lose in-progress input.
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [hermesConnectorUrl, setHermesConnectorUrl] = useState(() =>
    typeof window === "undefined"
      ? "http://localhost/api/hermes-gateway/ws"
      : defaultHermesConnectorUrl(window.location.origin),
  );
  const [hermesEnrollment, setHermesEnrollment] = useState<HermesGatewayEnrollmentResult | null>(
    null,
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [createdHermesIdentity, setCreatedHermesIdentity] = useState<{
    readonly instanceId: string;
    readonly nickname: string;
  } | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "Hermes enrollment command",
    onCopy: () =>
      toastManager.add({
        type: "success",
        title: "Hermes command copied",
        description: "Run it in the terminal where Hermes is installed.",
      }),
  });

  useEffect(() => {
    if (open) return;
    setWizardStep(0);
    setDriver(DEFAULT_DRIVER_KIND);
    setLabel("");
    setAccentColor("");
    setInstanceIdOverride(null);
    setHermesIdentityNonce(randomUUID());
    setConfigByDriver({});
    setHasAttemptedSubmit(false);
    setHermesConnectorUrl(
      typeof window === "undefined"
        ? "http://localhost/api/hermes-gateway/ws"
        : defaultHermesConnectorUrl(window.location.origin),
    );
    setHermesEnrollment(null);
    setSaveError(null);
    setIsSaving(false);
    setCreatedHermesIdentity(null);
  }, [open]);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
  const instanceId =
    driver === "hermes"
      ? createHermesProviderInstanceId(label, () => hermesIdentityNonce)
      : (instanceIdOverride ?? deriveInstanceId(driver, label));
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const instanceIdError =
    driver === "hermes" && label.trim().length === 0
      ? "Hermes nickname is required."
      : validateProviderInstanceIdForWizard({
          driver,
          instanceId,
          existingIds,
          createdHermesInstanceId: createdHermesIdentity?.instanceId ?? null,
        });
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const previewLabel = label.trim() || `${driverOption.label} Workspace`;
  const wizardStepSummaries = [driverOption.label, previewLabel, null] as const;

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

  const handleSave = async () => {
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
    // it via `validateProviderInstanceIdForWizard`, but going through the brand constructor
    // keeps the type boundary honest and guards against any future drift in
    // the slug rules.
    const brandedId = ProviderInstanceId.make(instanceId);
    const isOwnedHermesRetry = isOwnedHermesEnrollmentRetry({
      driver,
      instanceId,
      createdHermesInstanceId: createdHermesIdentity?.instanceId ?? null,
    });
    const nextMap = {
      ...settings.providerInstances,
      [brandedId]: nextInstance,
    };
    try {
      setIsSaving(true);
      setSaveError(null);
      if (driver === "hermes") {
        if (environmentId === null) {
          throw new Error("Connect this browser to a T3 server before pairing Hermes.");
        }
        if (!isOwnedHermesRetry) {
          const settingsResult = await updateServerSettings({
            environmentId,
            input: { patch: { providerInstances: nextMap } },
          });
          if (settingsResult._tag === "Failure") {
            throw squashAtomCommandFailure(settingsResult);
          }
          setCreatedHermesIdentity({
            instanceId,
            nickname: label.trim(),
          });
        }
        const enrollmentResult = await createHermesEnrollment({
          environmentId,
          input: {
            instanceId: brandedId,
            nickname: createdHermesIdentity?.nickname ?? label.trim(),
            connectorUrl: hermesConnectorUrl,
          },
        });
        if (enrollmentResult._tag === "Failure") {
          const enrollmentError = squashAtomCommandFailure(enrollmentResult);
          if (isHermesInstanceRemovedError(enrollmentError)) {
            setCreatedHermesIdentity(null);
            setHermesIdentityNonce(randomUUID());
          }
          throw enrollmentError;
        }
        setHermesEnrollment(enrollmentResult.value);
        toastManager.add({
          type: "success",
          title: "Hermes instance added",
          description: "Run the one-time command to connect it.",
        });
        setIsSaving(false);
        return;
      }

      updateSettings({ providerInstances: nextMap });
      toastManager.add({
        type: "success",
        title: "Provider instance added",
        description: `${driverOption.label} instance '${instanceId}' was added.`,
      });
      onOpenChange(false);
    } catch (error) {
      const message = messageFromUnknownError(error);
      setSaveError(message);
      toastManager.add({
        type: "error",
        title: "Could not add provider instance",
        description: message,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Add provider instance</DialogTitle>
            <DialogDescription>
              Configure an additional provider instance — for example, a second Codex install
              pointed at a different workspace.
            </DialogDescription>
            {hermesEnrollment === null && createdHermesIdentity === null ? (
              <AddProviderInstanceWizardSteps
                currentStep={wizardStep}
                summaries={wizardStepSummaries}
                instanceIdError={instanceIdError}
                onNavigation={applyWizardNavigation}
              />
            ) : null}
          </DialogHeader>

          <div
            data-slot="dialog-panel"
            className="space-y-4 bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5"
          >
            {hermesEnrollment ? (
              <div className="grid gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">Connect Hermes</p>
                  <p className="text-xs text-muted-foreground">
                    This one-time command expires{" "}
                    {formatHermesLastConnected(hermesEnrollment.expiresAt)}.
                  </p>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-2 text-[11px]">
                    {hermesEnrollment.command}
                  </code>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    onClick={() => copyToClipboard(hermesEnrollment.command, undefined)}
                    aria-label="Copy Hermes enrollment command"
                  >
                    {isCopied ? <CheckIcon /> : <CopyIcon />}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  The persistent gateway credential is delivered directly to the plugin and is never
                  shown in T3 Code.
                </p>
              </div>
            ) : (
              <AnimatedHeight>
                <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
                  <div
                    id="add-instance-driver-label"
                    className="text-sm font-medium text-foreground"
                  >
                    Driver
                  </div>
                  <RadioGroup
                    value={driver}
                    onValueChange={(value) => setDriver(ProviderDriverKind.make(value))}
                    aria-labelledby="add-instance-driver-label"
                    className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                  >
                    {DRIVER_OPTIONS.map((option) => {
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
                    {COMING_SOON_DRIVER_OPTIONS.map((option) => {
                      const IconComponent = option.icon;
                      return (
                        <RadioPrimitive.Root
                          key={option.value}
                          value={option.value}
                          disabled
                          className={cn(
                            "relative flex cursor-not-allowed items-center gap-3 rounded-lg bg-card/60 px-3 py-3 text-left opacity-55 outline-none ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5",
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
                      if (driver === "hermes") return;
                      setInstanceIdOverride(event.target.value);
                    }}
                    readOnly={driver === "hermes"}
                    aria-invalid={showInstanceIdError}
                  />
                  {showInstanceIdError ? (
                    <span className="text-[11px] text-destructive">{instanceIdError}</span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">
                      {driver === "hermes"
                        ? "Generated once for this gateway so historical threads can never be rebound."
                        : "Routing key used by threads and sessions. Letters, digits, '-', or '_'."}
                    </span>
                  )}
                </label>

                <div className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
                  <span className="text-xs font-medium text-foreground">Accent color</span>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <input
                      type="color"
                      value={
                        normalizeProviderAccentColor(accentColor) ?? PROVIDER_ACCENT_SWATCHES[0]
                      }
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

                {driver === "hermes" && wizardStep === 2 ? (
                  <label className="grid gap-2">
                    <span className="text-xs font-medium text-foreground">Connector URL</span>
                    <Input
                      className="bg-background"
                      value={hermesConnectorUrl}
                      onChange={(event) => setHermesConnectorUrl(event.target.value)}
                      placeholder="wss://t3.example.com/api/hermes-gateway/ws"
                      spellCheck={false}
                    />
                    <span className="text-[11px] text-muted-foreground">
                      Defaults to this browser&apos;s origin and works over Tailscale or any
                      reachable network.
                    </span>
                  </label>
                ) : driverSettingsFields.length > 0 ? (
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
                {saveError ? <p className="text-xs text-destructive">{saveError}</p> : null}
                {createdHermesIdentity ? (
                  <p className="text-xs text-muted-foreground">
                    The Hermes instance was added. Retry enrollment for this exact instance, or
                    close this dialog and finish pairing from its Settings card.
                  </p>
                ) : null}
              </AnimatedHeight>
            )}
          </div>

          <DialogFooter variant="bare">
            {hermesEnrollment ? (
              <Button size="sm" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (createdHermesIdentity) {
                    onOpenChange(false);
                    return;
                  }
                  if (wizardStep === 0) {
                    onOpenChange(false);
                    return;
                  }
                  setWizardStep((step) => Math.max(0, step - 1));
                }}
                disabled={isSaving}
              >
                {createdHermesIdentity ? "Close" : wizardStep === 0 ? "Cancel" : "Back"}
              </Button>
            )}
            {hermesEnrollment ? null : wizardStep < ADD_PROVIDER_WIZARD_STEPS.length - 1 ? (
              <Button size="sm" onClick={() => navigateToStep(wizardStep + 1)}>
                Next
              </Button>
            ) : (
              <Button size="sm" disabled={isSaving} onClick={() => void handleSave()}>
                {isSaving ? <LoaderIcon className="animate-spin" /> : null}
                {isSaving
                  ? createdHermesIdentity
                    ? "Retrying"
                    : "Adding"
                  : createdHermesIdentity
                    ? "Retry enrollment"
                    : "Add instance"}
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
