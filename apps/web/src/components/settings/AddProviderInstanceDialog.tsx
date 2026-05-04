"use client";

import {
  ArrowRightIcon,
  CheckIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ResolvedRegistryAcpAgent,
} from "@t3tools/contracts";
import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { AnimatedHeight } from "../AnimatedHeight";
import { Gemini, GithubCopilotIcon, PiAgentIcon, type Icon } from "../Icons";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";
import { deriveProviderSettingsFields, ProviderSettingsForm } from "./ProviderSettingsForm";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

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
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const DEFAULT_DRIVER_OPTION = DRIVER_OPTIONS[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
const MANUAL_ACP_REGISTRY_OPTION = "__manual__";

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

let environmentVariableDraftId = 0;
const nextEnvironmentVariableDraftId = () => `add-provider-env-${environmentVariableDraftId++}`;

type EnvironmentVariableDraft = ProviderInstanceEnvironmentVariable & {
  readonly id: string;
};

function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

function acpRegistryAgentSearchFields(entry: ResolvedRegistryAcpAgent): string[] {
  return [
    entry.agent.name,
    entry.agent.id,
    entry.agent.description,
    entry.agent.repository,
    entry.agent.website,
    entry.distributionType,
    entry.launch?.command,
    ...(entry.launch?.args ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => normalizeSearchQuery(value));
}

function acpRegistryAgentSearchText(entry: ResolvedRegistryAcpAgent): string {
  return acpRegistryAgentSearchFields(entry).join(" ");
}

function scoreAcpRegistryAgentSearchToken(
  field: string,
  token: string,
  fieldBase: number,
): number | null {
  return scoreQueryMatch({
    value: field,
    query: token,
    exactBase: fieldBase,
    prefixBase: fieldBase + 2,
    boundaryBase: fieldBase + 4,
    includesBase: fieldBase + 6,
    ...(token.length >= 3 ? { fuzzyBase: fieldBase + 100 } : {}),
  });
}

function scoreAcpRegistryAgentSearch(
  entry: ResolvedRegistryAcpAgent,
  query: string,
): number | null {
  const tokens = normalizeSearchQuery(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return 0;
  }

  const fields = acpRegistryAgentSearchFields(entry);
  const combinedField = acpRegistryAgentSearchText(entry);
  let score = 0;

  for (const token of tokens) {
    const tokenScores = [...fields, combinedField]
      .map((field, index) => scoreAcpRegistryAgentSearchToken(field, token, index * 10))
      .filter((fieldScore): fieldScore is number => fieldScore !== null);

    if (tokenScores.length === 0) {
      return null;
    }

    score += Math.min(...tokenScores);
  }

  return score;
}
function envRecordToVariables(
  env: Record<string, string> | null | undefined,
): ReadonlyArray<EnvironmentVariableDraft> {
  return Object.entries(env ?? {})
    .filter(([name]) => ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name))
    .map(([name, value]) => ({
      id: nextEnvironmentVariableDraftId(),
      name,
      value,
      sensitive: false,
    }));
}

function emptyEnvironmentVariable(): EnvironmentVariableDraft {
  return {
    id: nextEnvironmentVariableDraftId(),
    name: "",
    value: "",
    sensitive: true,
  };
}

function acpDistributionLabel(entry: ResolvedRegistryAcpAgent): string {
  switch (entry.distributionType) {
    case "npx":
      return "npx";
    case "uvx":
      return "uvx";
    case "binary":
      return "Installed";
    case "binaryUnsupported":
      return "Binary";
    case "manual":
      return "Manual";
  }
}

type AcpRegistryState =
  | { readonly status: "idle" | "loading"; readonly agents: readonly ResolvedRegistryAcpAgent[] }
  | {
      readonly status: "loaded";
      readonly registryVersion: string;
      readonly agents: readonly ResolvedRegistryAcpAgent[];
    }
  | {
      readonly status: "error";
      readonly agents: readonly ResolvedRegistryAcpAgent[];
      readonly error: string;
    };

interface AddProviderInstanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddProviderInstanceDialog({ open, onOpenChange }: AddProviderInstanceDialogProps) {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  const [wizardStep, setWizardStep] = useState(0);
  const [driver, setDriver] = useState<ProviderDriverKind>(DEFAULT_DRIVER_KIND);
  const [label, setLabel] = useState("");
  const [labelDirty, setLabelDirty] = useState(false);
  const [accentColor, setAccentColor] = useState<string>("");
  const [instanceId, setInstanceId] = useState("");
  const [instanceIdDirty, setInstanceIdDirty] = useState(false);
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  const [environmentVariables, setEnvironmentVariables] = useState<
    ReadonlyArray<EnvironmentVariableDraft>
  >([]);
  const [acpRegistryState, setAcpRegistryState] = useState<AcpRegistryState>({
    status: "idle",
    agents: [],
  });
  const [acpRegistrySearch, setAcpRegistrySearch] = useState("");
  const [selectedAcpRegistryAgentId, setSelectedAcpRegistryAgentId] = useState(
    MANUAL_ACP_REGISTRY_OPTION,
  );
  const [installingAcpAgentId, setInstallingAcpAgentId] = useState<string | null>(null);
  const [installConfirmAgent, setInstallConfirmAgent] = useState<ResolvedRegistryAcpAgent | null>(
    null,
  );
  const [installPath, setInstallPath] = useState("");
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );
  const isAcpRegistryDriver = driver === ACP_REGISTRY_DRIVER_KIND;

  useEffect(() => {
    if (!open) return;
    setDriver(DEFAULT_DRIVER_KIND);
    setLabel("");
    setLabelDirty(false);
    setAccentColor("");
    setInstanceId("");
    setWizardStep(0);
    setInstanceIdDirty(false);
    setConfigByDriver({});
    setEnvironmentVariables([]);
    setAcpRegistrySearch("");
    setSelectedAcpRegistryAgentId(MANUAL_ACP_REGISTRY_OPTION);
    setInstallingAcpAgentId(null);
    setInstallConfirmAgent(null);
    setInstallPath("");
    setHasAttemptedSubmit(false);
  }, [open]);

  useEffect(() => {
    if (instanceIdDirty) return;
    setInstanceId(deriveInstanceId(driver, label));
  }, [driver, label, instanceIdDirty]);

  useEffect(() => {
    setWizardStep((step) => Math.min(step, isAcpRegistryDriver ? 3 : 2));
  }, [isAcpRegistryDriver]);

  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const previewLabel = label.trim() || `${driverOption.label} Workspace`;
  const wizardSteps = isAcpRegistryDriver
    ? (["Driver", "Registry", "Identity", "Config"] as const)
    : (["Driver", "Identity", "Config"] as const);
  const registryStepIndex = isAcpRegistryDriver ? 1 : -1;
  const identityStepIndex = isAcpRegistryDriver ? 2 : 1;
  const configStepIndex = wizardSteps.length - 1;
  const selectedAcpRegistryAgent = useMemo(
    () =>
      acpRegistryState.agents.find((entry) => entry.agent.id === selectedAcpRegistryAgentId) ??
      null,
    [acpRegistryState.agents, selectedAcpRegistryAgentId],
  );
  const selectedAcpRegistryAgentNeedsInstall =
    selectedAcpRegistryAgent?.distributionType === "binaryUnsupported" &&
    Boolean(selectedAcpRegistryAgent.binaryInstall);
  const installingConfirmAgent =
    installConfirmAgent !== null && installingAcpAgentId === installConfirmAgent.agent.id;
  const wizardStepSummaries = [
    driverOption.label,
    ...(isAcpRegistryDriver
      ? [
          selectedAcpRegistryAgent
            ? selectedAcpRegistryAgent.agent.name
            : selectedAcpRegistryAgentId === MANUAL_ACP_REGISTRY_OPTION
              ? "Manual"
              : null,
        ]
      : []),
    previewLabel,
    null,
  ] as const;
  const filteredAcpRegistryAgents = useMemo(() => {
    const query = acpRegistrySearch.trim();
    const agents = acpRegistryState.agents;
    if (!query) return agents;
    return agents
      .map((entry) => ({
        entry,
        score: scoreAcpRegistryAgentSearch(entry, query),
        tieBreaker: acpRegistryAgentSearchText(entry),
      }))
      .filter(
        (
          rankedAgent,
        ): rankedAgent is {
          entry: ResolvedRegistryAcpAgent;
          score: number;
          tieBreaker: string;
        } => rankedAgent.score !== null,
      )
      .toSorted((left, right) => {
        const scoreDelta = left.score - right.score;
        if (scoreDelta !== 0) return scoreDelta;
        return left.tieBreaker.localeCompare(right.tieBreaker);
      })
      .map((rankedAgent) => rankedAgent.entry);
  }, [acpRegistrySearch, acpRegistryState.agents]);

  const loadAcpRegistry = useCallback(async () => {
    setAcpRegistryState((current) => ({ status: "loading", agents: current.agents }));
    try {
      const result = await ensureLocalApi().server.listAcpRegistry();
      setAcpRegistryState({
        status: "loaded",
        registryVersion: result.registryVersion,
        agents: result.agents,
      });
    } catch (error) {
      setAcpRegistryState((current) => ({
        status: "error",
        agents: current.agents,
        error: error instanceof Error ? error.message : "Registry request failed.",
      }));
    }
  }, []);

  useEffect(() => {
    if (!open || !isAcpRegistryDriver || acpRegistryState.status !== "idle") return;
    void loadAcpRegistry();
  }, [acpRegistryState.status, isAcpRegistryDriver, loadAcpRegistry, open]);

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const setConfigDraft = useCallback(
    (config: Record<string, unknown> | undefined) => {
      setConfigByDriver((existing) => {
        const next = { ...existing };
        if (config === undefined || Object.keys(config).length === 0) {
          delete next[driver];
        } else {
          next[driver] = config;
        }
        return next;
      });
    },
    [driver],
  );

  const applyAcpRegistryAgent = useCallback(
    (entry: ResolvedRegistryAcpAgent) => {
      const launch = entry.launch;
      if (!launch) return;
      setSelectedAcpRegistryAgentId(entry.agent.id);
      setConfigByDriver((existing) => ({
        ...existing,
        [ACP_REGISTRY_DRIVER_KIND]: {
          ...existing[ACP_REGISTRY_DRIVER_KIND],
          command: launch.command,
          args: launch.args,
          env: launch.env,
          iconUrl: entry.agent.icon ?? "",
          registryAgentId: entry.agent.id,
          importedVersion: entry.agent.version,
          distributionType: entry.distributionType,
        },
      }));
      setEnvironmentVariables(envRecordToVariables(launch.env));
      if (!labelDirty) {
        setLabel(entry.agent.name);
      }
      if (!instanceIdDirty) {
        setInstanceId(deriveInstanceId(ACP_REGISTRY_DRIVER_KIND, entry.agent.name));
      }
    },
    [instanceIdDirty, labelDirty],
  );

  const selectInstallableAcpRegistryAgent = useCallback(
    (entry: ResolvedRegistryAcpAgent) => {
      setSelectedAcpRegistryAgentId(entry.agent.id);
      setInstallPath(entry.binaryInstall?.defaultInstallPath ?? "");
      setEnvironmentVariables([]);
      if (!labelDirty) {
        setLabel(entry.agent.name);
      }
      if (!instanceIdDirty) {
        setInstanceId(deriveInstanceId(ACP_REGISTRY_DRIVER_KIND, entry.agent.name));
      }
    },
    [instanceIdDirty, labelDirty],
  );

  const selectManualAcpRegistryAgent = useCallback(() => {
    setSelectedAcpRegistryAgentId(MANUAL_ACP_REGISTRY_OPTION);
    setEnvironmentVariables([]);
  }, []);

  const handleInstallAcpRegistryAgent = useCallback(async () => {
    const entry = installConfirmAgent;
    if (!entry) return;
    setInstallingAcpAgentId(entry.agent.id);
    try {
      const trimmedInstallPath = installPath.trim();
      const result = await ensureLocalApi().server.installAcpRegistryBinary({
        agentId: entry.agent.id,
        ...(trimmedInstallPath ? { installPath: trimmedInstallPath } : {}),
      });
      if (!result.ok || !result.agent) {
        throw new Error(result.error ?? "Install failed.");
      }
      setAcpRegistryState((current) => ({
        ...current,
        agents: current.agents.map((candidate) =>
          candidate.agent.id === result.agent?.agent.id ? result.agent : candidate,
        ),
      }));
      applyAcpRegistryAgent(result.agent);
      setInstallConfirmAgent(null);
      setWizardStep(identityStepIndex);
      toastManager.add({
        type: "success",
        title: "ACP agent installed",
        description: `${entry.agent.name} is ready to use.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not install ACP agent",
        description: error instanceof Error ? error.message : "Install failed.",
      });
    } finally {
      setInstallingAcpAgentId(null);
    }
  }, [applyAcpRegistryAgent, identityStepIndex, installConfirmAgent, installPath]);

  const handleAdvanceWizard = useCallback(() => {
    if (wizardStep === registryStepIndex && selectedAcpRegistryAgentNeedsInstall) {
      setInstallPath(selectedAcpRegistryAgent?.binaryInstall?.defaultInstallPath ?? "");
      setInstallConfirmAgent(selectedAcpRegistryAgent);
      return;
    }
    setWizardStep((step) => Math.min(configStepIndex, step + 1));
  }, [
    configStepIndex,
    registryStepIndex,
    selectedAcpRegistryAgent,
    selectedAcpRegistryAgentNeedsInstall,
    wizardStep,
  ]);

  const updateEnvironmentVariable = useCallback(
    (
      index: number,
      patch: Partial<Pick<EnvironmentVariableDraft, "name" | "value" | "sensitive">>,
    ) => {
      setEnvironmentVariables((existing) =>
        existing.map((variable, variableIndex) =>
          variableIndex === index ? { ...variable, ...patch } : variable,
        ),
      );
    },
    [],
  );

  const removeEnvironmentVariable = useCallback((index: number) => {
    setEnvironmentVariables((existing) =>
      existing.filter((_variable, variableIndex) => variableIndex !== index),
    );
  }, []);

  const handleSave = useCallback(() => {
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null) return;

    const config: Record<string, unknown> = { ...configByDriver[driver] };
    if (driver === ACP_REGISTRY_DRIVER_KIND && selectedAcpRegistryAgent) {
      config.registryAgentId = selectedAcpRegistryAgent.agent.id;
      config.importedVersion = selectedAcpRegistryAgent.agent.version;
      config.distributionType = selectedAcpRegistryAgent.distributionType;
      if (selectedAcpRegistryAgent.agent.icon) {
        config.iconUrl = selectedAcpRegistryAgent.agent.icon;
      }
    }
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);
    const cleanedEnvironment = environmentVariables
      .map((variable) => ({
        value: variable.value,
        sensitive: variable.sensitive,
        name: variable.name.trim(),
      }))
      .filter((variable) => ENVIRONMENT_VARIABLE_NAME_PATTERN.test(variable.name));

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(cleanedEnvironment.length > 0 ? { environment: cleanedEnvironment } : {}),
      ...(selectedAcpRegistryAgent?.agent.icon
        ? { iconUrl: selectedAcpRegistryAgent.agent.icon }
        : {}),
      ...(hasConfig ? { config } : {}),
    };
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
  }, [
    accentColor,
    configByDriver,
    driver,
    driverOption,
    environmentVariables,
    instanceId,
    instanceIdError,
    label,
    onOpenChange,
    selectedAcpRegistryAgent,
    settings.providerInstances,
    updateSettings,
  ]);

  const renderEnvironmentVariables = () => (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">Environment variables</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() =>
            setEnvironmentVariables((existing) => [...existing, emptyEnvironmentVariable()])
          }
        >
          <PlusIcon className="size-3" />
          Add
        </Button>
      </div>
      {environmentVariables.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Add variables to pass API keys, base URLs, or other per-instance CLI settings.
        </p>
      ) : (
        <div className="grid gap-2">
          {environmentVariables.map((variable, index) => {
            const name = variable.name.trim();
            const nameInvalid = name.length > 0 && !ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name);
            return (
              <div
                key={variable.id}
                className="grid gap-2 rounded-md border border-border/70 bg-muted/20 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] sm:items-center"
              >
                <Input
                  value={variable.name}
                  onChange={(event) =>
                    updateEnvironmentVariable(index, { name: event.target.value })
                  }
                  placeholder="VARIABLE_NAME"
                  spellCheck={false}
                  aria-label={`Environment variable name ${index + 1}`}
                  className={cn("bg-background", nameInvalid && "border-destructive")}
                />
                <Input
                  value={variable.value}
                  onChange={(event) =>
                    updateEnvironmentVariable(index, { value: event.target.value })
                  }
                  type={variable.sensitive ? "password" : undefined}
                  autoComplete="off"
                  placeholder="Value"
                  spellCheck={false}
                  aria-label={`Environment variable value ${index + 1}`}
                  className="bg-background"
                />
                <label className="inline-flex h-8 items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5"
                    checked={variable.sensitive}
                    onChange={(event) =>
                      updateEnvironmentVariable(index, {
                        sensitive: event.currentTarget.checked,
                      })
                    }
                  />
                  Sensitive
                </label>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="size-8 justify-self-start text-muted-foreground hover:text-destructive sm:justify-self-end"
                  onClick={() => removeEnvironmentVariable(index)}
                  aria-label={`Remove environment variable ${variable.name || index + 1}`}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
      <span className="text-xs text-muted-foreground">
        Sensitive values are stored separately and are not returned to the app after saving.
      </span>
    </div>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup className="max-w-xl overflow-hidden">
          <div className="flex min-h-0 flex-col overflow-hidden border-foreground/10 bg-background shadow-2xl">
            <DialogHeader className="border-b border-border/70 bg-background">
              <DialogTitle>Add provider instance</DialogTitle>
              <DialogDescription>
                Configure an additional provider instance — for example, a second Codex install
                pointed at a different workspace.
              </DialogDescription>
              <div
                className="grid gap-2"
                style={{ gridTemplateColumns: `repeat(${wizardSteps.length}, minmax(0, 1fr))` }}
              >
                {wizardSteps.map((step, index) => (
                  <button
                    key={step}
                    type="button"
                    className={cn(
                      "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg border px-3 py-2 text-left transition",
                      index === wizardStep
                        ? "border-primary bg-primary/10 ring-1 ring-primary/25"
                        : index < wizardStep
                          ? "border-border bg-background"
                          : "border-border bg-muted/40",
                    )}
                    onClick={() => setWizardStep(index)}
                  >
                    <span
                      className={cn(
                        "row-span-2 mt-0.5 grid size-4 place-items-center rounded-full border",
                        index < wizardStep
                          ? "border-primary bg-primary text-primary-foreground"
                          : index === wizardStep
                            ? "border-primary bg-background"
                            : "border-muted-foreground/35 bg-background",
                      )}
                      aria-hidden
                    >
                      {index < wizardStep ? <CheckIcon className="size-3" /> : null}
                    </span>
                    <span className="text-[10px] font-medium uppercase text-muted-foreground">
                      Step {index + 1}
                    </span>
                    <span className="truncate text-xs font-semibold text-foreground">
                      {step}
                      {index < wizardStep && wizardStepSummaries[index]
                        ? `: ${wizardStepSummaries[index]}`
                        : ""}
                    </span>
                  </button>
                ))}
              </div>
            </DialogHeader>

            <div
              data-slot="dialog-panel"
              className="space-y-4 border-b border-border/70 bg-muted/20 px-6 py-5"
            >
              <AnimatedHeight>
                <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
                  <span
                    id="add-instance-driver-label"
                    className="text-xs font-medium text-foreground"
                  >
                    Driver
                  </span>
                  <RadioGroup
                    value={driver}
                    onValueChange={(value) => setDriver(ProviderDriverKind.make(value))}
                    aria-labelledby="add-instance-driver-label"
                    className="grid grid-cols-2 gap-2.5"
                  >
                    {DRIVER_OPTIONS.map((option) => {
                      const IconComponent = option.icon;
                      const isSelected = option.value === driver;
                      return (
                        <RadioPrimitive.Root
                          key={option.value}
                          value={option.value}
                          className={cn(
                            "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-[background-color,border-color,box-shadow]",
                            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                            isSelected
                              ? "border-primary bg-background shadow-sm ring-2 ring-primary/35"
                              : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50",
                          )}
                        >
                          <IconComponent className="size-5 shrink-0" aria-hidden />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                            {option.label}
                          </span>
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
                          className="relative flex cursor-not-allowed items-center gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left opacity-55 outline-none"
                        >
                          <IconComponent
                            className="size-5 shrink-0 text-muted-foreground"
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

                <div className={cn("grid gap-3", wizardStep !== registryStepIndex && "hidden")}>
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="relative min-w-0 flex-1">
                      <SearchIcon
                        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                        aria-hidden
                      />
                      <Input
                        className="bg-background pl-8"
                        placeholder="Search ACP agents..."
                        value={acpRegistrySearch}
                        onChange={(event) => setAcpRegistrySearch(event.target.value)}
                        spellCheck={false}
                      />
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="size-9"
                      onClick={() => void loadAcpRegistry()}
                      aria-label="Refresh ACP registry"
                      disabled={acpRegistryState.status === "loading"}
                    >
                      {acpRegistryState.status === "loading" ? (
                        <Loader2Icon className="size-4 animate-spin" />
                      ) : (
                        <RefreshCwIcon className="size-4" />
                      )}
                    </Button>
                  </div>

                  {acpRegistryState.status === "error" ? (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {acpRegistryState.error}
                    </div>
                  ) : null}

                  <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                    <button
                      type="button"
                      className={cn(
                        "w-full rounded-lg border px-3 py-2.5 text-left transition",
                        selectedAcpRegistryAgentId === MANUAL_ACP_REGISTRY_OPTION
                          ? "border-primary bg-background ring-2 ring-primary/25"
                          : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50",
                      )}
                      onClick={selectManualAcpRegistryAgent}
                    >
                      <div className="text-sm font-medium text-foreground">Manual ACP agent</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        Enter a launch command yourself on the next step.
                      </div>
                    </button>

                    {filteredAcpRegistryAgents.map((entry) => {
                      const isSelected = selectedAcpRegistryAgentId === entry.agent.id;
                      const canInstall =
                        entry.distributionType === "binaryUnsupported" && entry.binaryInstall;
                      const selectable = Boolean(canInstall || (entry.supported && entry.launch));
                      const unavailable = !selectable;
                      return (
                        <div
                          key={entry.agent.id}
                          role={selectable ? "button" : undefined}
                          tabIndex={selectable ? 0 : undefined}
                          className={cn(
                            "w-full rounded-lg border px-3 py-2.5 text-left transition",
                            isSelected
                              ? "border-primary bg-background ring-2 ring-primary/25"
                              : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50",
                            unavailable &&
                              "cursor-not-allowed opacity-50 hover:border-border hover:bg-background",
                          )}
                          onClick={() => {
                            if (canInstall) {
                              selectInstallableAcpRegistryAgent(entry);
                            } else if (entry.supported && entry.launch) {
                              applyAcpRegistryAgent(entry);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (!selectable || (event.key !== "Enter" && event.key !== " ")) {
                              return;
                            }
                            event.preventDefault();
                            if (canInstall) {
                              selectInstallableAcpRegistryAgent(entry);
                            } else {
                              applyAcpRegistryAgent(entry);
                            }
                          }}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            {entry.agent.icon ? (
                              <img
                                src={entry.agent.icon}
                                alt=""
                                className="size-5 shrink-0 rounded-sm object-contain dark:invert"
                                draggable={false}
                              />
                            ) : null}
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                              {entry.agent.name}
                            </span>
                            <Badge variant="outline" size="sm">
                              {entry.agent.version}
                            </Badge>
                            <Badge variant={entry.supported ? "secondary" : "warning"} size="sm">
                              {acpDistributionLabel(entry)}
                            </Badge>
                          </div>
                          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {entry.agent.description}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <label className={cn("grid gap-2", wizardStep !== identityStepIndex && "hidden")}>
                  <span className="text-xs font-medium text-foreground">Label</span>
                  <Input
                    className="bg-background"
                    placeholder="e.g. Work"
                    value={label}
                    onChange={(event) => {
                      setLabelDirty(true);
                      setLabel(event.target.value);
                    }}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Shown in the provider list. Optional.
                  </span>
                </label>

                <label className={cn("grid gap-2", wizardStep !== identityStepIndex && "hidden")}>
                  <span className="text-xs font-medium text-foreground">Instance ID</span>
                  <Input
                    className="bg-background"
                    placeholder={`${driver}_work`}
                    value={instanceId}
                    onChange={(event) => {
                      setInstanceIdDirty(true);
                      setInstanceId(event.target.value);
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

                <div className={cn("grid gap-2", wizardStep !== identityStepIndex && "hidden")}>
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

                <div className={cn("grid gap-4", wizardStep !== configStepIndex && "hidden")}>
                  {driverSettingsFields.length > 0 ? (
                    <ProviderSettingsForm
                      definition={driverOption}
                      value={configDraft}
                      idPrefix={`add-provider-${driver}`}
                      variant="dialog"
                      onChange={setConfigDraft}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      This driver has no required configuration. You can add the instance now.
                    </p>
                  )}
                  {renderEnvironmentVariables()}
                </div>
              </AnimatedHeight>
            </div>

            <DialogFooter className="border-t bg-background">
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
              {wizardStep < wizardSteps.length - 1 ? (
                <Button size="sm" onClick={handleAdvanceWizard}>
                  {wizardStep === registryStepIndex && selectedAcpRegistryAgentNeedsInstall
                    ? "Install"
                    : "Next"}
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
      <AlertDialog
        open={installConfirmAgent !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !installingConfirmAgent) setInstallConfirmAgent(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Install {installConfirmAgent?.agent.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              T3 Code will download and extract this agent binary from the archive URL published in
              the ACP registry. The registry does not currently provide checksums or signatures, so
              only install agents from publishers you trust.
            </AlertDialogDescription>
            {installConfirmAgent?.binaryInstall ? (
              <div className="grid gap-3 pt-2 text-left">
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">Download URL</span>
                  <ScrollArea
                    hideScrollbars
                    scrollFade
                    className="h-[34px] min-w-0 rounded-md border bg-background"
                  >
                    <div className="w-max select-all py-2 pr-2.5 pl-2.5 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                      {installConfirmAgent.binaryInstall.archiveUrl}
                    </div>
                  </ScrollArea>
                </div>
                <div className="flex items-center justify-center text-muted-foreground">
                  <ArrowRightIcon className="size-4 rotate-90 sm:rotate-0" />
                </div>
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">Binary path</span>
                  <Input
                    value={installPath}
                    onChange={(event) => setInstallPath(event.target.value)}
                    spellCheck={false}
                    className="bg-background font-mono text-xs"
                    placeholder={installConfirmAgent.binaryInstall.defaultInstallPath}
                  />
                </label>
              </div>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="outline" disabled={installingConfirmAgent} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              disabled={installingConfirmAgent}
              onClick={() => void handleInstallAcpRegistryAgent()}
            >
              {installingConfirmAgent ? <Loader2Icon className="mr-1 size-3 animate-spin" /> : null}
              Install
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
