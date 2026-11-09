import {
  type EnvironmentId,
  isSecretReference,
  type ProviderInstanceId,
  type SecretReference,
  type ServerProvider,
  type ServerSettingsPatch,
  TextGeneratorConfig,
  type TextGeneratorModel,
  type UnifiedSettings,
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
  suggestTextGeneratorModel,
  useTextGeneratorModels,
  TEXT_GENERATOR_PRESETS,
  type TextGeneratorPreset,
  textGeneratorBrand,
  textGeneratorDisplayName,
} from "../../textGenerators";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
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
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

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
          settings={settings}
          onClose={() => setEditing(null)}
          onSave={(patch) => {
            updateSettings(patch);
            setEditing(null);
          }}
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

const STEPS = ["Connect", "Choose a model", "Use it for"] as const;

/** Text tasks a new generator can take over, in the order the settings pages show them. */
const TASKS = [
  {
    key: "textGenerationModelSelection",
    label: "Thread titles and other generated text",
    followsDefault: false,
  },
  {
    key: "sourceControlWriterModelSelection",
    label: "Commit messages, pull requests, and branch names",
    followsDefault: true,
  },
  {
    key: "speechPostProcessingModelSelection",
    label: "Voice transcript cleanup",
    followsDefault: true,
  },
] as const;
type TaskKey = (typeof TASKS)[number]["key"];

type TaskSettings = Pick<UnifiedSettings, TaskKey>;

/**
 * Connect, check the key by listing models, pick one, then choose which tasks use it. The key goes
 * once to the environment's secret storage; settings keep only a redaction marker.
 */
function TextGeneratorWizard({
  environmentId,
  editing,
  settings,
  onClose,
  onSave,
  newId,
}: {
  readonly environmentId: EnvironmentId;
  readonly editing: Editing;
  readonly settings: TaskSettings;
  readonly onClose: () => void;
  readonly onSave: (patch: ServerSettingsPatch) => void;
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
  const [models, setModels] = useState<ReadonlyArray<TextGeneratorModel>>([]);
  const [model, setModel] = useState<string | null>(null);
  const generatorId = editing === "new" ? newId(preset) : editing.id;
  const uses = (key: TaskKey) => settings[key]?.instanceId === generatorId;
  const [tasks, setTasks] = useState<Record<TaskKey, boolean>>(() =>
    existing
      ? {
          textGenerationModelSelection: uses("textGenerationModelSelection"),
          sourceControlWriterModelSelection: uses("sourceControlWriterModelSelection"),
          speechPostProcessingModelSelection: uses("speechPostProcessingModelSelection"),
        }
      : {
          textGenerationModelSelection: true,
          sourceControlWriterModelSelection: false,
          speechPostProcessingModelSelection: false,
        },
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
    setChecking(true);
    setCheckError(null);
    const result = await checkTextGeneratorConfig(environmentId, generatorId, config.value);
    setChecking(false);
    if ("error" in result) {
      setCheckError(result.error);
      return;
    }
    setModels(result.models);
    const current = TASKS.map((task) => settings[task.key]).find(
      (selection) => selection?.instanceId === generatorId,
    )?.model;
    setModel(
      current && result.models.some((candidate) => candidate.id === current)
        ? current
        : (suggestTextGeneratorModel(result.models)?.id ?? null),
    );
    setStep(1);
  };

  const save = () => {
    if (!Option.isSome(config) || model === null) return;
    const selection = createModelSelection(generatorId, model);
    const patch: Record<string, unknown> = { textGenerators: { [generatorId]: config.value } };
    for (const task of TASKS) {
      if (tasks[task.key]) patch[task.key] = selection;
      // Turning a task off returns it to following the text generation model.
      else if (task.followsDefault && uses(task.key)) patch[task.key] = null;
    }
    onSave(patch as ServerSettingsPatch);
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
          ) : step === 1 ? (
            <div className="grid gap-3">
              <p className="text-sm text-muted-foreground">
                {models.length === 0
                  ? `${name} answered but listed no models.`
                  : `${name} works. Pick the model to write with; ${models.length === 1 ? "it lists 1 model" : `it lists ${models.length} models`}.`}
              </p>
              <TextGeneratorModelList models={models} selected={model} onSelect={setModel} />
            </div>
          ) : (
            <div className="grid gap-3">
              <p className="text-sm text-muted-foreground">
                Use {model} from {name} for:
              </p>
              {TASKS.map((task) => {
                const locked = !task.followsDefault && existing !== null && uses(task.key);
                return (
                  <label key={task.key} className="flex items-start gap-2.5 text-sm">
                    <Checkbox
                      checked={tasks[task.key]}
                      disabled={locked}
                      onCheckedChange={(checked) =>
                        setTasks((current) => ({ ...current, [task.key]: checked === true }))
                      }
                    />
                    <span className="grid gap-0.5">
                      <span>{task.label}</span>
                      {locked ? (
                        <span className="text-xs text-muted-foreground">
                          To stop, pick another model in Settings → Threads.
                        </span>
                      ) : task.followsDefault && !tasks[task.key] && settings[task.key] === null ? (
                        <span className="text-xs text-muted-foreground">
                          Already follows the text generation model.
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </WizardPanel>
        <WizardFooter
          leading={
            step > 0 ? (
              <Button variant="ghost" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            ) : null
          }
        >
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {step === 0 ? (
            <Button onClick={() => void connect()} disabled={!canConnect || checking}>
              {checking ? <Spinner /> : null}
              {checking ? "Checking" : "Continue"}
            </Button>
          ) : step === 1 ? (
            <Button onClick={() => setStep(2)} disabled={model === null}>
              Continue
            </Button>
          ) : (
            <Button onClick={save}>{existing ? "Save" : "Add"}</Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
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
