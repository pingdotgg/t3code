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
import { CheckIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  checkTextGeneratorConfig,
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
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { searchableSetting } from "./settingsSearch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

const decodeTextGenerator = Schema.decodeUnknownOption(TextGeneratorConfig);

const KIND_LABELS = {
  openaiCompatible: "OpenAI-compatible",
  anthropic: "Anthropic",
} satisfies Record<TextGeneratorConfig["kind"], string>;

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
                <span className="inline-flex items-center gap-2">
                  <ProviderInstanceIcon
                    driverKind={textGeneratorBrand(config)}
                    displayName={name}
                    badgeContent="none"
                  />
                  {name}
                </span>
              }
              description={
                <span className="break-all">
                  {KIND_LABELS[config.kind]}
                  {config.enabled ? "" : " · Off"} · {config.baseUrl}
                </span>
              }
              control={
                readOnly ? null : (
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={!config.enabled}
                      onClick={() => setViewing({ id, config })}
                    >
                      Models
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setEditing({ id, config })}>
                      Edit
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setRemoving(id)}>
                      Remove
                    </Button>
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
          onSave={(id, config) => updateSettings({ textGenerators: { [id]: config } })}
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
              This deletes the API key stored on {environmentLabel}. Anything set to use this
              generator falls back to the text generation model.
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
  { key: "textGenerationModelSelection", label: "Thread titles and other generated text" },
  {
    key: "sourceControlWriterModelSelection",
    label: "Commit messages, pull requests, and branch names",
  },
  { key: "speechPostProcessingModelSelection", label: "Voice transcript cleanup" },
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
  const [step, setStep] = useState(0);
  const [preset, setPreset] = useState(TEXT_GENERATOR_PRESETS[0]!);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? preset.baseUrl);
  const [label, setLabel] = useState(existing?.label ?? "");
  const secretSources = useSecretSources(environmentId);
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>(
    isSecretReference(existing?.apiKey) ? existing.apiKey : "",
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
  const storedKey = typeof existing?.apiKey === "string" ? existing.apiKey : "";
  const apiKey = typeof keyDraft === "string" ? keyDraft.trim() || storedKey : keyDraft;
  const kind = existing?.kind ?? preset.kind;
  const config = decodeTextGenerator({
    kind,
    ...(label.trim() ? { label: label.trim() } : {}),
    baseUrl: baseUrl.trim(),
    apiKey,
    enabled: existing?.enabled ?? true,
  });
  const keyRequired = existing === null && preset.id !== "custom";
  const canConnect = keyValid && Option.isSome(config) && (!keyRequired || apiKey !== "");
  const name = Option.isSome(config) ? textGeneratorDisplayName(config.value) : preset.label;

  const connect = async () => {
    if (!canConnect || checking) return;
    const id = savedId ?? newId(preset);
    setChecking(true);
    setCheckError(null);
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
          description="Writes thread titles, commit messages, and other short text without starting a coding agent. Your API key is stored on this environment."
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
              {existing === null ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="text-generator-preset">Service</Label>
                  <Select
                    value={preset.id}
                    onValueChange={(value) => {
                      const next = TEXT_GENERATOR_PRESETS.find(
                        (candidate) => candidate.id === value,
                      );
                      if (!next) return;
                      setPreset(next);
                      setBaseUrl(next.baseUrl);
                      setCheckError(null);
                    }}
                  >
                    <SelectTrigger id="text-generator-preset" size="sm" aria-label="Service">
                      <SelectValue>
                        {(value: string) =>
                          TEXT_GENERATOR_PRESETS.find((candidate) => candidate.id === value)?.label
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {TEXT_GENERATOR_PRESETS.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
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
                  onValidityChange={setKeyValid}
                />
              </div>
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
            </form>
          ) : (
            <div className="grid gap-4">
              <p className="text-sm text-muted-foreground">
                {name} is connected and lists {modelCount} {modelCount === 1 ? "model" : "models"}.
                Switch any of these to it, or keep what they use now.
              </p>
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
            <Button onClick={onClose}>Done</Button>
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
    <div className="flex items-center justify-between gap-3">
      <div className="grid min-w-0 flex-1 gap-0.5">
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
      <div className="flex shrink-0 items-center gap-1.5">
        {testable ? (
          <Button
            size="xs"
            variant="ghost"
            aria-busy={testing}
            disabled={testing}
            onClick={() => void test()}
          >
            {testing ? <Spinner /> : null}
            {testing ? "Testing" : "Test"}
          </Button>
        ) : null}
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
    </div>
  );
}

/** Searchable models; selectable when `onSelect` is given. */
function TextGeneratorModelList({
  models,
  selected,
  onSelect,
}: {
  readonly models: ReadonlyArray<TextGeneratorModel>;
  readonly selected?: string | null;
  readonly onSelect?: (id: string) => void;
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
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      <div className="max-h-64 overflow-y-auto rounded-lg border">
        {shown.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No models match.</p>
        ) : (
          <ul role={onSelect ? "listbox" : "list"} aria-label="Models">
            {shown.map((model) => {
              const isSelected = model.id === selected;
              const label = (
                <>
                  <span className="min-w-0 flex-1 truncate">{model.name}</span>
                  {model.name !== model.id ? (
                    <span className="max-w-[45%] truncate text-xs text-muted-foreground">
                      {model.id}
                    </span>
                  ) : null}
                  {isSelected ? <CheckIcon className="size-4 shrink-0 text-primary" /> : null}
                </>
              );
              return (
                <li
                  key={model.id}
                  role={onSelect ? "option" : undefined}
                  aria-selected={onSelect ? isSelected : undefined}
                >
                  {onSelect ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                      onClick={() => onSelect(model.id)}
                    >
                      {label}
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 px-3 py-1.5 text-sm">{label}</div>
                  )}
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
              : `${models.length} ${models.length === 1 ? "model" : "models"} available. Pick one in a text generation model picker.`}
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
            <TextGeneratorModelList models={models} />
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
