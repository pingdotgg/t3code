import {
  type EnvironmentId,
  isSecretReference,
  type ProviderInstanceId,
  type SecretReference,
  type ServerProvider,
  TextGeneratorConfig,
  type TextGeneratorModel,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CheckIcon, MoreVertical, PlusIcon, ServerIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  checkTextGeneratorConfig,
  rereadTextGeneratorModels,
  nextTextGeneratorId,
  refreshTextGeneratorModels,
  testTextGeneratorModel,
  useTextGenerationTargets,
  useTextGeneratorModels,
  TEXT_GENERATOR_PRESETS,
  type TextGeneratorPreset,
  textGeneratorBrand,
  textGeneratorDisplayName,
} from "../../textGenerators";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { toastManager } from "../ui/toast";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { searchableSetting } from "./settingsSearch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

const decodeTextGenerator = Schema.decodeUnknownOption(TextGeneratorConfig);

type Saved = { readonly id: ProviderInstanceId; readonly config: TextGeneratorConfig };
type Editing = Saved | "new";

/** Rows that list, add, edit, and remove one environment's text generators. */
export function TextGeneratorsSettings({
  environmentId,
  environmentLabel,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<ProviderInstanceId | null>(null);
  const [viewing, setViewing] = useState<Saved | null>(null);
  const generators = Object.entries(settings.textGenerators) as Array<
    [ProviderInstanceId, TextGeneratorConfig]
  >;
  const removingConfig = removing === null ? undefined : settings.textGenerators[removing];

  return (
    <>
      <SettingsSection
        {...searchableSetting("text-generators")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon className="size-3" aria-hidden />
              Add generator
            </Button>
          ) : null
        }
      >
        {generators.length === 0 ? (
          <SettingsRow
            title="No text generators yet"
            description="Add a model API to write thread titles, commit messages, and other short text without starting a coding agent."
          />
        ) : null}
        {generators.map(([id, config]) => {
          const name = textGeneratorDisplayName(config);
          return (
            <SettingsRow
              key={id}
              title={
                <span className="inline-flex items-center gap-2.5">
                  <ProviderInstanceIcon
                    driverKind={textGeneratorBrand(config)}
                    displayName={name}
                    badgeContent="none"
                  />
                  {name}
                </span>
              }
              description={
                // Indented past the icon so it lines up with the name.
                <span className="block truncate ps-7.5">
                  {config.enabled ? "" : "Off · "}
                  {config.kind === "opencode"
                    ? providers.find(
                        (provider) => provider.instanceId === config.providerInstanceId,
                      )?.displayName || config.providerInstanceId
                    : config.baseUrl.replace(/^https?:\/\//, "")}
                </span>
              }
              control={
                readOnly ? null : (
                  <div className="flex items-center gap-2">
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost-muted"
                            aria-label={`More actions for ${name}`}
                          />
                        }
                      >
                        <MoreVertical />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem onClick={() => setEditing({ id, config })}>Edit</MenuItem>
                        <MenuItem
                          disabled={!config.enabled}
                          onClick={() => setViewing({ id, config })}
                        >
                          Choose models
                        </MenuItem>
                        <MenuItem variant="destructive" onClick={() => setRemoving(id)}>
                          Remove
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                    <Switch
                      checked={config.enabled}
                      onCheckedChange={(enabled) =>
                        updateSettings({ textGenerators: { [id]: { ...config, enabled } } })
                      }
                      aria-label={`Enable ${name}`}
                    />
                  </div>
                )
              }
            />
          );
        })}
      </SettingsSection>
      {editing !== null ? (
        <TextGeneratorWizard
          environmentId={environmentId}
          editing={editing}
          providers={providers}
          onClose={() => setEditing(null)}
          onSave={(id, config) =>
            updateSettings(
              { textGenerators: { [id]: config } },
              { onSaved: () => rereadTextGeneratorModels(environmentId, id) },
            )
          }
          newId={(preset) => nextTextGeneratorId(preset.id, settings, providers)}
        />
      ) : null}
      {viewing !== null ? (
        <TextGeneratorModelsDialog
          environmentId={environmentId}
          saved={viewing}
          onClose={() => setViewing(null)}
        />
      ) : null}
      <AlertDialog
        open={removingConfig !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removingConfig ? textGeneratorDisplayName(removingConfig) : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removingConfig?.kind === "opencode"
                ? "This removes only the text generator. Your OpenCode provider, sign-in, and API keys are kept."
                : `This deletes the API key stored on ${environmentLabel}.`}{" "}
              Anything set to use this generator falls back to the text generation model.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) updateSettings({ textGenerators: { [removing]: null } });
                setRemoving(null);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const STEPS = ["Connect", "Use it"] as const;

/** Text tasks a generator can write, in the order the settings pages show them. */
const TASKS = [
  {
    key: "textGenerationModelSelection",
    label: "Thread titles and other generated text",
    shortLabel: "Thread titles",
  },
  {
    key: "sourceControlWriterModelSelection",
    label: "Commit messages, pull requests, and branch names",
    shortLabel: "Source control",
  },
  {
    key: "speechPostProcessingModelSelection",
    label: "Voice transcript cleanup",
    shortLabel: "Voice cleanup",
  },
] as const;

/**
 * Connect checks the settings by listing the service's models and saves the generator; Use it then
 * shows each text task's model picker, so any of them can switch to it. The key goes once to the
 * environment's secret storage; settings keep only a redaction marker.
 */
function TextGeneratorWizard({
  environmentId,
  editing,
  providers,
  onClose,
  onSave,
  newId,
}: {
  readonly environmentId: EnvironmentId;
  readonly editing: Editing;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onClose: () => void;
  readonly onSave: (id: ProviderInstanceId, config: TextGeneratorConfig) => void;
  readonly newId: (preset: TextGeneratorPreset) => ProviderInstanceId;
}) {
  const existing = editing === "new" ? null : editing.config;
  const apiExisting = existing?.kind === "opencode" ? null : existing;
  const openCodeProviders = providers.filter(
    (provider) => provider.driver === "opencode" && provider.enabled,
  );
  const [providerInstanceId, setProviderInstanceId] = useState(
    existing?.kind === "opencode"
      ? existing.providerInstanceId
      : (openCodeProviders[0]?.instanceId ?? ""),
  );
  const [step, setStep] = useState(0);
  const [preset, setPreset] = useState(TEXT_GENERATOR_PRESETS[0]!);
  const [baseUrl, setBaseUrl] = useState(apiExisting?.baseUrl ?? preset.baseUrl);
  const [label, setLabel] = useState(existing?.label ?? "");
  const secretSources = useSecretSources(environmentId);
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>(
    isSecretReference(apiExisting?.apiKey) ? apiExisting.apiKey : "",
  );
  const [keyValid, setKeyValid] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [modelCount, setModelCount] = useState(0);
  // Fixed once saved, so editing the form again after Back updates the same generator.
  const [savedId, setSavedId] = useState<ProviderInstanceId | null>(
    editing === "new" ? null : editing.id,
  );

  // A saved literal key arrives redacted; sending the marker back keeps it.
  const storedKey = typeof apiExisting?.apiKey === "string" ? apiExisting.apiKey : "";
  const apiKey = typeof keyDraft === "string" ? keyDraft.trim() || storedKey : keyDraft;
  const kind = existing?.kind ?? preset.kind;
  const config = decodeTextGenerator({
    kind,
    ...(label.trim() ? { label: label.trim() } : {}),
    ...(kind === "opencode" ? { providerInstanceId } : { baseUrl: baseUrl.trim(), apiKey }),
    enabled: existing?.enabled ?? true,
  });
  const keyRequired = kind !== "opencode" && existing === null && preset.id !== "custom";
  // Presets know their URL; only a custom endpoint, or one already saved as such, asks for it.
  const showBaseUrl =
    kind !== "opencode" &&
    (existing === null
      ? preset.id === "custom"
      : !["openai", "anthropic", "openrouter"].includes(textGeneratorBrand(existing)));
  const canConnect =
    (kind === "opencode" || keyValid) && Option.isSome(config) && (!keyRequired || apiKey !== "");
  const name = Option.isSome(config) ? textGeneratorDisplayName(config.value) : preset.label;

  const connect = async () => {
    if (!canConnect || checking) return;
    const id = savedId ?? newId(preset);
    setChecking(true);
    setCheckError(null);
    // The form is disabled while this runs, so the checked config is the one saved below.
    const result = await checkTextGeneratorConfig(environmentId, id, config.value);
    setChecking(false);
    if ("error" in result) {
      setCheckError(result.error);
      return;
    }
    onSave(id, config.value);
    setSavedId(id);
    setModelCount(result.models.length);
    setStep(1);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <WizardPopup>
        <WizardHeader
          title={existing ? `Edit ${textGeneratorDisplayName(existing)}` : "Add a text generator"}
          description={
            kind === "opencode"
              ? "Uses an existing OpenCode provider's server, accounts, and models for raw text generation. No separate API key is needed."
              : "Writes thread titles, commit messages, and other short text without starting a coding agent. Your API key is stored on this environment."
          }
        >
          <WizardSteps
            steps={STEPS}
            currentStep={step}
            isStepDisabled={(index) => index > step}
            onStepChange={setStep}
          />
        </WizardHeader>
        <WizardPanel>
          {step === 0 ? (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void connect();
              }}
            >
              <fieldset disabled={checking} className="contents">
                {existing === null ? (
                  <div className="grid gap-1.5">
                    <span className="text-sm font-medium">Service</span>
                    <div
                      role="radiogroup"
                      aria-label="Service"
                      className="grid grid-cols-2 gap-2 sm:grid-cols-4"
                    >
                      {TEXT_GENERATOR_PRESETS.map((candidate) => {
                        const selected = candidate.id === preset.id;
                        return (
                          <button
                            key={candidate.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={
                              selected
                                ? "flex flex-col items-center gap-2 rounded-lg border border-primary bg-primary/5 px-2 py-3 text-sm font-medium text-foreground ring-1 ring-primary ring-inset outline-none focus-visible:ring-2 focus-visible:ring-inset"
                                : "flex flex-col items-center gap-2 rounded-lg border bg-background px-2 py-3 text-sm text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                            }
                            onClick={() => {
                              setPreset(candidate);
                              setBaseUrl(candidate.baseUrl);
                              setCheckError(null);
                            }}
                          >
                            {candidate.id === "custom" ? (
                              <ServerIcon className="size-5" aria-hidden />
                            ) : (
                              <ProviderInstanceIcon
                                driverKind={textGeneratorBrand(candidate)}
                                displayName={candidate.label}
                                badgeContent="none"
                              />
                            )}
                            {candidate.id === "custom" ? "Custom" : candidate.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
                {showBaseUrl ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="text-generator-url">Base URL</Label>
                    <Input
                      id="text-generator-url"
                      placeholder="http://localhost:11434/v1"
                      value={baseUrl}
                      onChange={(event) => {
                        setBaseUrl(event.target.value);
                        setCheckError(null);
                      }}
                      spellCheck={false}
                      autoFocus={existing === null && preset.id === "custom"}
                    />
                  </div>
                ) : null}
                {kind === "opencode" ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="text-generator-opencode">OpenCode provider</Label>
                    <Select
                      value={providerInstanceId}
                      onValueChange={(value) => {
                        if (value !== null) setProviderInstanceId(value);
                        setCheckError(null);
                      }}
                    >
                      <SelectTrigger id="text-generator-opencode" aria-label="OpenCode provider">
                        <SelectValue placeholder="Choose an OpenCode provider" />
                      </SelectTrigger>
                      <SelectPopup>
                        {openCodeProviders.map((provider) => (
                          <SelectItem key={provider.instanceId} value={provider.instanceId}>
                            {provider.displayName || "OpenCode"} ({provider.instanceId})
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      {openCodeProviders.length === 0
                        ? "Add and enable an OpenCode 2 provider in Settings → Providers first."
                        : "Requires OpenCode 2 and a model that supports raw generation."}
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-1.5">
                    <Label htmlFor="text-generator-key">
                      {keyRequired ? "API key" : "API key (optional)"}
                    </Label>
                    <SecretSourceInput
                      id="text-generator-key"
                      aria-label="API key"
                      value={keyDraft}
                      configured={storedKey !== ""}
                      sources={secretSources}
                      onChange={(event) => {
                        setKeyDraft(event.target.value);
                        setCheckError(null);
                      }}
                      onSecretChange={(secret) => setKeyDraft(secret ?? "")}
                      autoFocus={existing === null && preset.id !== "custom"}
                      onValidityChange={setKeyValid}
                    />
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="text-generator-label">Name (optional)</Label>
                  <Input
                    id="text-generator-label"
                    placeholder={
                      existing !== null
                        ? textGeneratorDisplayName(existing)
                        : preset.id === "custom"
                          ? "e.g. My local model"
                          : preset.label
                    }
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </div>
                {checkError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {checkError}
                  </p>
                ) : null}
              </fieldset>
            </form>
          ) : (
            <div className="grid gap-4">
              <p className="text-sm text-muted-foreground">
                {name} is connected and lists {modelCount} {modelCount === 1 ? "model" : "models"}.
                Switch any of these to it, or keep what they use now.
              </p>
              {/* One grid for all rows, so pickers and Test buttons line up in columns. */}
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-4">
                {TASKS.map((task) => (
                  <TextGenerationTaskPicker
                    key={task.key}
                    environmentId={environmentId}
                    providers={providers}
                    settingKey={task.key}
                    label={task.label}
                  />
                ))}
              </div>
            </div>
          )}
        </WizardPanel>
        <WizardFooter
          leading={
            step > 0 ? (
              <Button variant="ghost" onClick={() => setStep(0)}>
                Back
              </Button>
            ) : null
          }
        >
          {step === 0 ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => void connect()} disabled={!canConnect || checking}>
                {checking ? <Spinner /> : null}
                {checking ? "Connecting" : existing ? "Save and continue" : "Connect"}
              </Button>
            </>
          ) : (
            // Connect's button unmounts here; without this, focus lands on the step list.
            <Button autoFocus onClick={onClose}>
              Done
            </Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

/** One text task's model, saved as it changes, with every text generation target to pick from. */
function TextGenerationTaskPicker({
  environmentId,
  providers,
  settingKey,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settingKey: (typeof TASKS)[number]["key"];
  readonly label: string;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const own = settings[settingKey];
  // Source control and voice follow the text generation model until they get their own.
  const selection = own ?? settings.textGenerationModelSelection;
  const targets = useTextGenerationTargets({
    environmentId,
    settings,
    providers: providers.filter((provider) => provider.supportsTextGeneration !== false),
    projectId: null,
    selections: [selection],
  });
  // Only a text generator's model can be tried cheaply; agents start a whole session.
  const testable = Object.hasOwn(settings.textGenerators, selection.instanceId);
  const testKey = `${selection.instanceId}:${selection.model}`;
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{
    readonly key: string;
    readonly error: string | null;
  } | null>(null);
  const shown = result?.key === testKey ? result : null;
  const test = async () => {
    setTesting(true);
    const error = await testTextGeneratorModel(
      environmentId,
      selection.instanceId,
      selection.model,
    );
    setTesting(false);
    setResult({ key: testKey, error });
  };
  return (
    <>
      <div className="grid min-w-0 gap-0.5 pe-2">
        <span className="text-sm">{label}</span>
        {shown?.error ? (
          <span role="alert" className="text-xs text-destructive">
            {shown.error}
          </span>
        ) : shown ? (
          <span role="status" className="text-xs text-muted-foreground">
            {selection.model} answered. It works.
          </span>
        ) : own === null ? (
          <span className="text-xs text-muted-foreground">Follows the text generation model</span>
        ) : null}
      </div>
      <div className="justify-self-end">
        <ProviderModelPicker
          environmentId={environmentId}
          activeInstanceId={selection.instanceId}
          model={selection.model}
          lockedProvider={null}
          instanceEntries={targets.entries}
          modelOptionsByInstance={getCustomModelOptionsByInstance(
            settings,
            targets.providers,
            selection.instanceId,
            selection.model,
          )}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          onInstanceModelChange={(instanceId, model) =>
            updateSettings({ [settingKey]: createModelSelection(instanceId, model) })
          }
        />
      </div>
      <div className="justify-self-end">
        {testable ? (
          <Button
            size="xs"
            variant="outline"
            aria-busy={testing}
            disabled={testing}
            onClick={() => void test()}
          >
            {/* Keeps the label's width while testing, so the row never reflows. */}
            <span className="relative">
              <span className={testing ? "invisible" : undefined}>Test</span>
              {testing ? (
                <span className="absolute inset-0 flex items-center justify-center">
                  <Spinner />
                </span>
              ) : null}
            </span>
          </Button>
        ) : null}
      </div>
    </>
  );
}

function TextGeneratorModelList({
  models,
  selected,
  onSelect,
}: {
  readonly models: ReadonlyArray<TextGeneratorModel>;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? models.filter(
        (model) =>
          model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
      )
    : models;
  return (
    <div className="grid gap-2">
      {models.length > 8 ? (
        <Input
          type="search"
          placeholder="Search models"
          aria-label="Search models"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      <div className="max-h-80 overflow-y-auto rounded-lg border divide-y divide-border/60">
        {shown.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No models match.</p>
        ) : (
          <ul aria-label="Models">
            {shown.map((model) => {
              const isSelected = model.id === selected;
              return (
                <li key={model.id}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    onClick={() => onSelect(model.id)}
                  >
                    <span className="grid min-w-0 flex-1">
                      <span className="truncate">{model.name}</span>
                      {model.name !== model.id ? (
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {model.id}
                        </span>
                      ) : null}
                    </span>
                    {isSelected ? <CheckIcon className="size-4 shrink-0 text-primary" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A saved generator's models, with a refresh that asks the API again. */
function TextGeneratorModelsDialog({
  environmentId,
  saved,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly saved: Saved;
  readonly onClose: () => void;
}) {
  const name = textGeneratorDisplayName(saved.config);
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [taskKey, setTaskKey] = useState<(typeof TASKS)[number]["key"]>(
    () =>
      TASKS.find(
        (task) =>
          (settings[task.key] ?? settings.textGenerationModelSelection).instanceId === saved.id,
      )?.key ?? TASKS[0].key,
  );
  const own = settings[taskKey];
  const selection = own ?? settings.textGenerationModelSelection;
  const selected = selection.instanceId === saved.id ? selection.model : null;
  const result = useTextGeneratorModels(environmentId, saved.id, saved.config);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    const outcome = await refreshTextGeneratorModels(environmentId, saved.id);
    setRefreshing(false);
    if ("error" in outcome) {
      toastManager.add({
        type: "error",
        title: `Couldn't load ${name} models`,
        description: outcome.error,
      });
    }
  };
  const models = AsyncResult.isSuccess(result) ? result.value : null;
  const error = Option.getOrUndefined(AsyncResult.error(result));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{name} models</DialogTitle>
          <DialogDescription>
            {models === null
              ? error
                ? "The model list couldn't load."
                : "Loading the model list."
              : `${models.length} ${models.length === 1 ? "model" : "models"} available. Choose a task, then click a model to use it.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : models === null ? (
            <Spinner tone="muted" />
          ) : (
            <div className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="text-generator-model-task">Use model for</Label>
                <Select
                  value={taskKey}
                  onValueChange={(value) => {
                    const task = TASKS.find((candidate) => candidate.key === value);
                    if (task !== undefined) setTaskKey(task.key);
                  }}
                >
                  <SelectTrigger id="text-generator-model-task" aria-label="Use model for">
                    <SelectValue>
                      {TASKS.find((task) => task.key === taskKey)?.shortLabel}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {TASKS.map((task) => (
                      <SelectItem key={task.key} value={task.key}>
                        {task.shortLabel}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p aria-live="polite" className="text-xs text-muted-foreground">
                  Current model:{" "}
                  {selected === null
                    ? selection.model
                    : (models.find((model) => model.id === selected)?.name ?? selected)}
                  {selected === null ? " (another provider)" : ""}
                  {own === null ? " · Follows the text generation model" : ""}
                </p>
              </div>
              <TextGeneratorModelList
                models={models}
                selected={selected}
                onSelect={(model) =>
                  updateSettings({ [taskKey]: createModelSelection(saved.id, model) })
                }
              />
            </div>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <RefreshIcon refreshing={refreshing} />
            Refresh
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
