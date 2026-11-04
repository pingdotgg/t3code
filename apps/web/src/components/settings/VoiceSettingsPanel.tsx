import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  removeEnvironmentSpeechModel,
  selectEnvironmentSpeechModel,
  updateEnvironmentSpeechAcceleration,
  updateEnvironmentSpeechModelUnloadTimeout,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  AuthSettingsWriteScope,
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  type EnvironmentId,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
  type SpeechAcceleration,
  type SpeechCustomWords,
  type SpeechModelUnloadTimeout,
  type VoiceShortcutMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";
import { effectiveSpeechLanguage } from "@t3tools/shared/speech";
import {
  AudioLinesIcon,
  CheckIcon,
  DownloadIcon,
  LanguagesIcon,
  MicIcon,
  RefreshCwIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { listBrowserMicrophones, type BrowserMicrophone } from "../../speech/browserMicrophones";
import {
  chooseAudioDestination,
  chooseTranscriptCleanup,
  useCleanupGrant,
} from "../../speech/voiceConsent";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { runtime } from "../../lib/runtime";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import {
  useEnvironmentSpeechInput,
  useVoiceTranscriptionDestination,
} from "../../speech/useEnvironmentSpeechInput";
import { ComposerSpeechButton, ComposerSpeechRecordingPill } from "../chat/ComposerSpeechButton";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { VoiceInputSetup } from "../chat/VoiceInputSetup";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { MicrophoneTest } from "./MicrophoneTest";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const OFF = "off";
const SYSTEM_DEFAULT = "system-default";
const formatSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
const languageLabel = (code: string) => languageNames.of(code) ?? code;
const SHORTCUT_MODE_LABELS: Record<VoiceShortcutMode, string> = {
  auto: "Auto: tap to toggle, hold to record",
  hold: "Hold: record while the keys are down",
  toggle: "Toggle: press to start and to finish",
};
const UNLOAD_LABELS: Record<SpeechModelUnloadTimeout, string> = {
  never: "Never",
  immediately: "Immediately",
  min_2: "After 2 minutes",
  min_5: "After 5 minutes",
  min_10: "After 10 minutes",
  min_15: "After 15 minutes",
  hour_1: "After 1 hour",
};
const normalizeTerm = (value: string) =>
  value
    .replace(/[<>"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
const spellingsOf = (words: SpeechCustomWords) =>
  new Set(
    words.flatMap(({ term, aliases }) =>
      [term, ...aliases].map((spelling) => spelling.toLocaleLowerCase()),
    ),
  );
const modelSortOrder = (model: EnvironmentSpeechModel) => {
  if (model.active) return 0;
  if (model.state === "installed") return 1;
  if (model.state === "downloading" || model.state === "verifying") return 2;
  return model.recommended ? 3 : 4;
};

function ModelCard(props: {
  readonly model: EnvironmentSpeechModel;
  readonly busy: boolean;
  readonly canCancel: boolean;
  readonly onDownload: () => void;
  readonly onSelect: () => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}) {
  const { model } = props;
  const downloading = model.state === "downloading" || model.state === "verifying";
  const progress = model.downloaded === undefined ? 0 : (model.downloaded / model.size) * 100;
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium leading-5">{model.name}</span>
          {model.recommended ? (
            <Badge variant="outline">
              <StarIcon className="mr-1 size-3" />
              Recommended
            </Badge>
          ) : null}
          {model.supportsStreaming ? (
            <Badge variant="outline">
              <AudioLinesIcon className="mr-1 size-3" />
              Live preview
            </Badge>
          ) : null}
          {model.supportsTranslation ? (
            <Badge variant="outline">
              <LanguagesIcon className="mr-1 size-3" />
              Translate
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {model.description}{" "}
          {model.languages.length === 1
            ? languageLabel(model.languages[0]!)
            : `${model.languages.length} languages`}
          {" · "}
          {formatSize(model.size)}
        </p>
        {downloading ? (
          <div className="mt-2">
            <div
              role="progressbar"
              aria-label={`${model.name} download progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
              className="h-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-1 text-2xs text-muted-foreground">
              {model.state === "verifying"
                ? "Verifying download…"
                : `${Math.round(progress)}% downloaded`}
            </p>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {downloading ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Cancel ${model.name} download`}
            disabled={!props.canCancel}
            onClick={props.onCancel}
          >
            <XIcon className="size-3.5" />
          </Button>
        ) : model.state === "downloadable" ? (
          <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onDownload}>
            <DownloadIcon className="mr-1.5 size-3.5" />
            Download
          </Button>
        ) : model.active ? (
          <Button size="sm" variant="secondary" disabled>
            <CheckIcon className="mr-1.5 size-3.5" />
            Selected
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onSelect}>
            Use model
          </Button>
        )}
        {model.state === "installed" ? (
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={props.busy}
            aria-label={`Delete ${model.name}`}
            onClick={props.onDelete}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function DictionaryEditor(props: {
  readonly label: string;
  readonly words: SpeechCustomWords;
  readonly disabled?: boolean;
  readonly onChange: (words: SpeechCustomWords) => void;
}) {
  const { words, label, disabled = false, onChange } = props;
  const [termDraft, setTermDraft] = useState("");
  const [aliasDraft, setAliasDraft] = useState<{ term: string; value: string } | null>(null);
  const spellings = spellingsOf(words);
  const seen = new Set(spellings);
  const newTerms = termDraft
    .split(/[,\n]/)
    .map(normalizeTerm)
    .filter((term) => {
      const key = term.toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const canAddTerm =
    !disabled &&
    newTerms.length > 0 &&
    newTerms.every((term) => term.length <= 50) &&
    words.length + newTerms.length <= 100;
  const addTerm = () => {
    if (!canAddTerm) return;
    onChange([...words, ...newTerms.map((term) => ({ term, aliases: [] }))]);
    setTermDraft("");
  };
  const addAlias = () => {
    if (!aliasDraft) return;
    const value = normalizeTerm(aliasDraft.value);
    if (!value || value.length > 50 || spellings.has(value.toLocaleLowerCase())) return;
    onChange(
      words.map((entry) =>
        entry.term === aliasDraft.term && entry.aliases.length < 8
          ? { term: entry.term, aliases: [...entry.aliases, value] }
          : entry,
      ),
    );
    setAliasDraft(null);
  };
  return (
    <>
      <div className="flex items-center gap-1.5">
        <Textarea
          value={termDraft}
          rows={1}
          maxLength={5_100}
          disabled={disabled}
          placeholder="Add words or phrases, separated by commas or new lines"
          aria-label={`Add a word or phrase to the ${label}`}
          onChange={(event) => setTermDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            addTerm();
          }}
        />
        <Button type="button" size="sm" disabled={!canAddTerm} onClick={addTerm}>
          Add
        </Button>
      </div>
      {words.length > 0 ? (
        <ul aria-label={`${label} entries`} className="mt-3 flex flex-wrap gap-1.5">
          {words.map(({ term, aliases }) => (
            <li
              key={term}
              className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 py-0.5 pl-2 pr-0.5 text-xs"
            >
              <span className="font-medium">{term}</span>
              {aliases.length > 0 ? (
                <span className="text-muted-foreground">← {aliases.join(", ")}</span>
              ) : null}
              {aliasDraft?.term === term ? (
                <Input
                  autoFocus
                  value={aliasDraft.value}
                  maxLength={50}
                  aria-label={`Alias for ${term}`}
                  placeholder="Misspelling"
                  className="h-6 w-32"
                  onChange={(event) => setAliasDraft({ term, value: event.target.value })}
                  onBlur={() => setAliasDraft(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setAliasDraft(null);
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addAlias();
                  }}
                />
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled || aliases.length >= 8}
                  aria-label={`Add an alias for ${term}`}
                  onClick={() => setAliasDraft({ term, value: "" })}
                >
                  Alias
                </Button>
              )}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                disabled={disabled}
                aria-label={`Remove ${term}`}
                onClick={() => onChange(words.filter((entry) => entry.term !== term))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Vocabulary stored on the environment with the project, read by everyone who dictates there. */
function ProjectDictionaryRow() {
  const scope = useOptionalSettingsScope();
  const words = useScopedSettings((settings) => settings.speechProjectCustomWords);
  const updateScopedSettings = useUpdateScopedSettings();
  if (scope === null) return null;
  const isProjectScope = scope.scope.kind === "project" || scope.scope.kind === "checkout";
  return (
    <SettingsRow
      serverScoped
      settingKeys={["speechProjectCustomWords"]}
      {...searchableSetting("speech-project-dictionary")}
      title={isProjectScope ? "Project dictionary" : "Shared dictionary"}
      description={
        isProjectScope
          ? `Saved with ${scope.scope.label} on its environment and used by everyone who dictates in it, together with their personal dictionary. Project spellings win when the two overlap.`
          : "Saved on the environment and used for every project there, together with each person's personal dictionary. Pick a project above to keep words to that project."
      }
      control={
        <span className="text-xs text-muted-foreground">
          {words.length} {words.length === 1 ? "entry" : "entries"}
        </span>
      }
    >
      <div className="mt-2">
        <DictionaryEditor
          label={isProjectScope ? "project dictionary" : "shared dictionary"}
          words={words}
          disabled={scope.connectedEnvironments.length === 0}
          onChange={(next) => updateScopedSettings({ speechProjectCustomWords: next })}
        />
      </div>
    </SettingsRow>
  );
}

/** Cleanup runs on the draft's environment, so its model is an environment setting there. */
function CleanupModelRow() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = providers.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = providerInstanceEntriesFor(textGenerationProviders, settings, null);
  const hasProvider = instanceEntries.some((entry) => entry.enabled && entry.isAvailable);
  const dedicated = settings.speechPostProcessingModelSelection !== null;
  const selection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveSpeechPostProcessingModelSelection(
        settings,
        textGenerationProviders,
      ),
    },
    textGenerationProviders,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const setModel = (next: ReturnType<typeof createModelSelection>) => {
    const reason = modelDisabledReason(next.instanceId, next.model);
    if (reason) {
      toastManager.add({ type: "error", title: "Cleanup model not saved", description: reason });
      return;
    }
    updateSettings({ speechPostProcessingModelSelection: next });
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={["speechPostProcessingModelSelection"]}
      {...searchableSetting("speech-post-processing-model")}
      title="Cleanup model"
      description={
        dedicated
          ? `Transcripts from drafts on ${environment?.label ?? "this environment"} are cleaned with this model instead of its text generation model.`
          : `Uses the text generation model of ${environment?.label ?? "this environment"}. Pick a model to clean transcripts with a cheaper or faster one.`
      }
      resetAction={
        dedicated ? (
          <SettingResetButton
            label="cleanup model"
            onClick={() => updateSettings({ speechPostProcessingModelSelection: null })}
          />
        ) : null
      }
      control={
        connectedEnvironments.length === 0 ? (
          <span className="text-sm text-muted-foreground">Connect an environment first.</span>
        ) : !hasProvider || !instanceEntry ? (
          <span className="text-sm text-muted-foreground">No providers available.</span>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={environment?.environmentId ?? null}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              getModelDisabledReason={modelDisabledReason}
              onInstanceModelChange={(instanceId, model) =>
                setModel(createModelSelection(instanceId, model))
              }
            />
            <TraitsPicker
              provider={instanceEntry.driverKind}
              models={instanceEntry.models}
              model={selection.model}
              modelOptions={selection.options ?? []}
              allowPromptInjectedEffort={false}
              planModeEnabled={settings.planModeEnabled}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onModelOptionsChange={(options) =>
                setModel(createModelSelection(selection.instanceId, selection.model, options))
              }
            />
          </div>
        )
      }
    />
  );
}

/** Model storage and resources live on the chosen environment; this section edits them there. */
function EnvironmentModelsSection(props: {
  readonly prepared: PreparedConnection;
  readonly status: EnvironmentSpeechStatus | null;
  readonly onStatus: (connection: PreparedConnection, status: EnvironmentSpeechStatus) => void;
}) {
  const { prepared, status, onStatus } = props;
  const canManage = useEnvironmentScope(prepared.environmentId, AuthSettingsWriteScope);
  const [models, setModels] = useState<readonly EnvironmentSpeechModel[]>([]);
  const [search, setSearch] = useState("");
  const [languageFilter, setLanguageFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestedDownload, setRequestedDownload] = useState<string | null>(null);
  const [actionConnection, setActionConnection] = useState(prepared);
  if (actionConnection !== prepared) {
    setActionConnection(prepared);
    setBusy(false);
    setRequestedDownload(null);
    setModels([]);
  }
  const epoch = useRef(0);
  const refreshRevision = useRef(0);
  const refresh = useStableCallback(async (connection: PreparedConnection) => {
    const current = epoch.current;
    const revision = ++refreshRevision.current;
    try {
      const [nextStatus, nextModels] = await Promise.all([
        runtime.runPromise(getEnvironmentSpeechStatus(connection)),
        runtime.runPromise(getEnvironmentSpeechModels(connection)),
      ]);
      if (current !== epoch.current || revision !== refreshRevision.current) return;
      onStatus(connection, nextStatus);
      setModels(nextModels.models);
    } catch (error) {
      if (current !== epoch.current || revision !== refreshRevision.current) return;
      toastManager.add({
        type: "error",
        title: "Could not load transcription models",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's model catalog when its connection becomes available
  useEffect(() => {
    epoch.current += 1;
    void refresh(prepared);
    return () => {
      epoch.current += 1;
    };
  }, [prepared, refresh]);
  const downloading =
    requestedDownload !== null ||
    models.some((model) => model.state === "downloading" || model.state === "verifying");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls progress while a local request or the environment reports an active download
  useEffect(() => {
    if (!downloading) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh(prepared);
      if (!cancelled) timer = window.setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [downloading, prepared, refresh]);

  const run = async (label: string, work: () => Promise<unknown>, downloadId?: string) => {
    if (!canManage) return;
    const current = epoch.current;
    if (downloadId) setRequestedDownload(downloadId);
    else setBusy(true);
    try {
      await work();
    } catch (error) {
      if (current === epoch.current)
        toastManager.add({
          type: "error",
          title: label,
          description: error instanceof Error ? error.message : String(error),
        });
    }
    if (current === epoch.current) {
      if (downloadId) setRequestedDownload(null);
      else setBusy(false);
      await refresh(prepared);
    }
  };
  const controlsDisabled = busy || downloading || !canManage;
  const supported = status?.supported ? status : null;
  const languages = [...new Set(models.flatMap((model) => model.languages))].sort((a, b) =>
    languageLabel(a).localeCompare(languageLabel(b)),
  );
  const query = search.trim().toLocaleLowerCase();
  const sortedModels = models
    .filter(
      (model) =>
        (!languageFilter || model.languages.includes(languageFilter)) &&
        (!query || (model.name + " " + model.description).toLocaleLowerCase().includes(query)),
    )
    .toSorted((left, right) => modelSortOrder(left) - modelSortOrder(right));

  return (
    <SettingsSection id={searchableSetting("speech-models").id} title="Transcription models">
      {status && !status.supported ? (
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
          This environment cannot transcribe: {status.reason}.
        </p>
      ) : null}
      {supported ? (
        <>
          <SettingsRow
            title="Hardware"
            description="Auto uses a GPU when the environment has one."
            control={
              <Select
                value={supported.acceleration}
                disabled={controlsDisabled}
                onValueChange={(value) => {
                  if (value)
                    void run("Could not change hardware", () =>
                      runtime.runPromise(
                        updateEnvironmentSpeechAcceleration(prepared, value as SpeechAcceleration),
                      ),
                    );
                }}
              >
                <SelectTrigger size="sm" aria-label="Transcription hardware" className="max-w-72">
                  <SelectValue>
                    {supported.acceleration === "auto"
                      ? "Auto"
                      : supported.acceleration === "cpu"
                        ? "CPU"
                        : (supported.gpuDevices.find(
                            (device) => `gpu:${device.id}` === supported.acceleration,
                          )?.name ?? "Selected GPU")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="cpu">CPU</SelectItem>
                  {supported.gpuDevices.map((device) => (
                    <SelectItem key={device.id} value={`gpu:${device.id}`}>
                      {device.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title="Unload model"
            description="Free the model's memory on the environment after it sits idle."
            control={
              <Select
                value={supported.modelUnloadTimeout}
                disabled={controlsDisabled}
                onValueChange={(value) => {
                  if (value)
                    void run("Could not change unload timing", () =>
                      runtime.runPromise(
                        updateEnvironmentSpeechModelUnloadTimeout(
                          prepared,
                          value as SpeechModelUnloadTimeout,
                        ),
                      ),
                    );
                }}
              >
                <SelectTrigger size="sm" aria-label="Unload model" className="max-w-72">
                  <SelectValue>{UNLOAD_LABELS[supported.modelUnloadTimeout]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(Object.keys(UNLOAD_LABELS) as SpeechModelUnloadTimeout[]).map((timeout) => (
                    <SelectItem key={timeout} value={timeout}>
                      {UNLOAD_LABELS[timeout]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title="Find a model"
            control={
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Search transcription models"
                  placeholder="Search models"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <Select
                  value={languageFilter || "all"}
                  onValueChange={(value) => setLanguageFilter(value === "all" ? "" : (value ?? ""))}
                >
                  <SelectTrigger size="sm" aria-label="Filter models by language">
                    <SelectValue>
                      {languageFilter ? languageLabel(languageFilter) : "All languages"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end">
                    <SelectItem value="all">All languages</SelectItem>
                    {languages.map((code) => (
                      <SelectItem key={code} value={code}>
                        {languageLabel(code)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            }
          />
          {sortedModels.length === 0 ? (
            <p className="px-4 py-2 text-sm text-muted-foreground">No matching models.</p>
          ) : null}
          <div className="divide-y divide-border/60" aria-label="Transcription models">
            {sortedModels.map((model) => (
              <ModelCard
                key={model.id}
                model={
                  model.id === requestedDownload && model.state === "downloadable"
                    ? { ...model, state: "downloading" }
                    : model
                }
                busy={controlsDisabled}
                canCancel={canManage && !busy}
                onDownload={() =>
                  void run(
                    "Could not download the model",
                    () => runtime.runPromise(downloadEnvironmentSpeechModel(prepared, model.id)),
                    model.id,
                  )
                }
                onSelect={() =>
                  void run("Could not select the model", () =>
                    runtime.runPromise(selectEnvironmentSpeechModel(prepared, model.id)),
                  )
                }
                onCancel={() =>
                  void run("Could not cancel the download", () =>
                    runtime.runPromise(cancelEnvironmentSpeechModelDownload(prepared, model.id)),
                  )
                }
                onDelete={() =>
                  void run("Could not delete the model", () =>
                    runtime.runPromise(removeEnvironmentSpeechModel(prepared, model.id)),
                  )
                }
              />
            ))}
          </div>
        </>
      ) : null}
    </SettingsSection>
  );
}

/**
 * Exercises the same consent-gated path the composer uses, into a throwaway draft, but
 * never the cleanup provider: this checks the model, the loopback test checks the mic.
 */
function TranscriptionTest(props: {
  readonly environmentId: EnvironmentId;
  readonly modelName: string | null;
}) {
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed draft to the asynchronous transcription controller
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const speech = useEnvironmentSpeechInput({
    environmentId: props.environmentId,
    ownerKey: "settings:transcription-test",
    draftText: draft,
    cleanup: false,
    readDraft: () => ({
      text: draftRef.current,
      selection: { start: draftRef.current.length, end: draftRef.current.length },
    }),
    commitDraft: (text) => setDraft(text),
  });
  return (
    <SettingsRow
      {...searchableSetting("transcription-test")}
      title="Test model"
      description={`Dictate a sentence with ${props.modelName ?? "the selected model"} on the chosen environment, using the language and dictionary above. Transcript cleanup is skipped so you see what the model heard. The result stays on this page.`}
      control={
        <div className="flex items-center gap-1">
          <ComposerSpeechRecordingPill
            state={speech.state}
            progress={null}
            level={speech.level}
            onStart={() => void speech.start()}
            onStop={() => void speech.stop()}
            onCancel={() => speech.cancel()}
            onSkipPostProcessing={() => speech.skipPostProcessing()}
          />
          {speech.available ? (
            <ComposerSpeechButton
              state={speech.state}
              progress={null}
              onStart={() => void speech.start()}
              onCancel={() => speech.cancel()}
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              {speech.status?.supported === false
                ? speech.status.reason
                : "Waiting for the environment"}
            </span>
          )}
        </div>
      }
    >
      {speech.preview ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {speech.preview.committed}
          <span className="opacity-70">{speech.preview.tentative}</span>
        </p>
      ) : null}
      <Textarea
        aria-label="Test transcript"
        className="mt-2"
        value={draft}
        placeholder="The transcript appears here."
        onChange={(event) => setDraft(event.target.value)}
      />
      <VoiceInputSetup
        environmentId={speech.transcriptionEnvironmentId}
        open={speech.setup.open}
        step={speech.setup.step}
        status={speech.status}
        model={speech.setup.model}
        downloading={speech.setup.downloading}
        error={speech.setup.error}
        onOpenChange={speech.setup.setOpen}
        onDownload={() => void speech.setup.download()}
        onCancelDownload={() => void speech.setup.cancelDownload()}
        onStartRecording={() => void speech.setup.startRecording()}
      />
    </SettingsRow>
  );
}

export function VoiceSettingsPanel() {
  const cleanupEnabled = useCleanupGrant() !== null;
  const settings = useClientSettings();
  const settingsScope = useOptionalSettingsScope();
  const destination = useVoiceTranscriptionDestination();
  const { environments } = useEnvironments();
  const [microphones, setMicrophones] = useState<BrowserMicrophone[]>([]);
  const [catalog, setCatalog] = useState<{
    connection: PreparedConnection;
    status: EnvironmentSpeechStatus;
  } | null>(null);

  const refreshMicrophones = useStableCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      setMicrophones(await listBrowserMicrophones());
    } catch {
      setMicrophones([]);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to microphone device changes while settings are open
  useEffect(() => {
    queueMicrotask(() => void refreshMicrophones());
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onChange = () => void refreshMicrophones();
    mediaDevices.addEventListener("devicechange", onChange);
    return () => mediaDevices.removeEventListener("devicechange", onChange);
  }, [refreshMicrophones]);
  const prepared = destination.prepared;
  const modelStatus = catalog?.connection === prepared ? catalog.status : null;

  const selectedMicrophone = settings.voiceMicrophone;
  const selectedMicrophoneLabel = selectedMicrophone
    ? (microphones.find((device) => device.deviceId === selectedMicrophone)?.label ??
      "Selected microphone (unavailable)")
    : "System default";
  const destinationValue = destination.environmentId ?? OFF;
  const chosenEnvironment = environments.find(
    (environment) => environment.environmentId === destination.environmentId,
  );
  const chosenUnsupported =
    chosenEnvironment?.serverConfig !== null &&
    chosenEnvironment?.serverConfig?.environment.capabilities.voiceTranscription !== true;
  const model = prepared && modelStatus?.supported ? modelStatus : null;
  const languages = model?.languages ?? [];
  const resolvedLanguage = model
    ? effectiveSpeechLanguage(
        { languages, supportsLanguageDetection: model.supportsLanguageDetection ?? false },
        settings.speechLanguage,
      )
    : settings.speechLanguage;

  return (
    <SettingsPageContainer>
      <SettingsSection id="voice-input" title="Voice input">
        <SettingsRow
          {...searchableSetting("voice-transcription-destination")}
          title="Send microphone audio to"
          description={
            <>
              Microphone audio recorded on this device is sent to the environment you choose here,
              where it is transcribed and discarded. Off keeps voice input off on this device. This
              choice is saved on this device only.
            </>
          }
          control={
            <Select
              value={destinationValue}
              onValueChange={(value) => {
                if (!value) return;
                chooseAudioDestination(
                  value === OFF
                    ? null
                    : { kind: "environment", environmentId: value as EnvironmentId },
                );
              }}
            >
              <SelectTrigger size="sm" aria-label="Send microphone audio to" className="max-w-72">
                <SelectValue>
                  {destinationValue === OFF
                    ? "Off"
                    : (chosenEnvironment?.label ?? "Chosen environment (unavailable)")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={OFF}>Off</SelectItem>
                {environments.map((environment) => (
                  <SelectItem key={environment.environmentId} value={environment.environmentId}>
                    {environment.label}
                  </SelectItem>
                ))}
                {destination.environmentId && !chosenEnvironment ? (
                  <SelectItem value={destination.environmentId}>
                    Chosen environment (unavailable)
                  </SelectItem>
                ) : null}
              </SelectPopup>
            </Select>
          }
        >
          {destination.environmentId && chosenUnsupported ? (
            <p className="mt-2 text-xs text-destructive">
              {chosenEnvironment?.label ?? "This environment"} cannot transcribe audio. Voice input
              stays off until you choose an environment that can.
            </p>
          ) : null}
        </SettingsRow>
        <SettingsRow
          {...searchableSetting("voice-microphone")}
          title="Microphone"
          description="System default follows the operating system when devices change."
          control={
            <div className="flex items-center gap-1.5">
              <Select
                value={selectedMicrophone ? `device:${selectedMicrophone}` : SYSTEM_DEFAULT}
                onValueChange={(value) => {
                  if (value)
                    void updateClientSettings({
                      voiceMicrophone:
                        value === SYSTEM_DEFAULT ? "" : value.slice("device:".length),
                    });
                }}
              >
                <SelectTrigger size="sm" aria-label="Microphone" className="max-w-64">
                  <SelectValue>{selectedMicrophoneLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={SYSTEM_DEFAULT}>System default</SelectItem>
                  {microphones.map((device) => (
                    <SelectItem key={device.deviceId} value={`device:${device.deviceId}`}>
                      {device.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh microphones"
                onClick={() => void refreshMicrophones()}
              >
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("dictation-shortcut-mode")}
          title="Dictation shortcut"
          description="How the dictation keybinding starts and finishes a recording."
          control={
            <Select
              value={settings.voiceShortcutMode}
              onValueChange={(value) => {
                if (value)
                  void updateClientSettings({ voiceShortcutMode: value as VoiceShortcutMode });
              }}
            >
              <SelectTrigger size="sm" aria-label="Dictation shortcut mode" className="max-w-72">
                <SelectValue>{SHORTCUT_MODE_LABELS[settings.voiceShortcutMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(Object.keys(SHORTCUT_MODE_LABELS) as VoiceShortcutMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {SHORTCUT_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection id="voice-recognition" title="Recognition">
        <SettingsRow
          {...searchableSetting("speech-language")}
          title="Language"
          description={
            model
              ? `${model.model} ${model.supportsLanguageDetection ? "can detect the language" : "uses a fixed language"}.`
              : "Choose an environment to see which languages its model supports."
          }
          control={
            <Select
              value={settings.speechLanguage}
              disabled={!model}
              onValueChange={(value) => {
                if (value) void updateClientSettings({ speechLanguage: value });
              }}
            >
              <SelectTrigger size="sm" aria-label="Transcription language" className="max-w-64">
                <SelectValue>
                  {settings.speechLanguage === "auto"
                    ? resolvedLanguage === "auto"
                      ? "Auto-detect"
                      : `Auto (${languageLabel(resolvedLanguage)})`
                    : languageLabel(settings.speechLanguage)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="auto">Auto</SelectItem>
                {languages
                  .toSorted((left, right) =>
                    languageLabel(left).localeCompare(languageLabel(right)),
                  )
                  .map((code) => (
                    <SelectItem key={code} value={code}>
                      {languageLabel(code)}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
          }
        />
        {model?.supportsTranslation ? (
          <SettingsRow
            title="Translate to English"
            description="Write English text whatever language you speak."
            control={
              <Switch
                aria-label="Translate to English"
                checked={settings.speechTranslateToEnglish}
                onCheckedChange={(checked) =>
                  void updateClientSettings({ speechTranslateToEnglish: checked })
                }
              />
            }
          />
        ) : null}
        <SettingsRow
          {...searchableSetting("remove-filler-words")}
          title="Remove filler words"
          description="Drop hesitation sounds such as um and uh from transcripts."
          control={
            <Switch
              aria-label="Remove filler words"
              checked={settings.speechRemoveFillerWords}
              onCheckedChange={(checked) =>
                void updateClientSettings({ speechRemoveFillerWords: checked })
              }
            />
          }
        />
        <SettingsRow
          {...searchableSetting("speech-dictionary")}
          title="Dictionary"
          description="Names and terms the model should get right, saved on this device. Add an alias to a term to correct a spelling transcription keeps producing. The name of the project you dictate in is a hint too."
          control={
            <span className="text-xs text-muted-foreground">
              {settings.speechCustomWords.length}{" "}
              {settings.speechCustomWords.length === 1 ? "entry" : "entries"}
            </span>
          }
        >
          <div className="mt-2">
            <DictionaryEditor
              label="dictionary"
              words={settings.speechCustomWords}
              onChange={(words) => void updateClientSettings({ speechCustomWords: words })}
            />
          </div>
        </SettingsRow>
        <ProjectDictionaryRow />
      </SettingsSection>

      <SettingsSection
        id={searchableSetting("speech-post-processing").id}
        title="Transcript cleanup"
      >
        <SettingsRow
          title="Clean up transcripts with a provider"
          description="After transcription, the transcript and the text around the cursor in your draft are sent to the text generation provider configured on the draft's environment, which fixes punctuation, numbers, and spoken corrections. Off by default; it never runs on the audio itself."
          control={
            <Switch
              aria-label="Clean up transcripts with a provider"
              checked={cleanupEnabled}
              onCheckedChange={chooseTranscriptCleanup}
            />
          }
        />
        {cleanupEnabled ? (
          <SettingsRow
            title="Cleanup instructions"
            description="Use the built-in instructions or write your own."
            control={
              <Select
                value={settings.speechPostProcessingPrompt.mode}
                onValueChange={(value) => {
                  if (value === "default" || value === "custom")
                    void updateClientSettings({
                      speechPostProcessingPrompt: {
                        ...settings.speechPostProcessingPrompt,
                        mode: value,
                      },
                    });
                }}
              >
                <SelectTrigger size="sm" aria-label="Cleanup instructions" className="max-w-64">
                  <SelectValue>
                    {settings.speechPostProcessingPrompt.mode === "custom" ? "Custom" : "Built-in"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="default">Built-in</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectPopup>
              </Select>
            }
          >
            <Textarea
              aria-label="Custom cleanup instructions"
              className="mt-2"
              maxLength={10_000}
              disabled={settings.speechPostProcessingPrompt.mode !== "custom"}
              value={
                settings.speechPostProcessingPrompt.mode === "custom"
                  ? settings.speechPostProcessingPrompt.customInstructions
                  : DEFAULT_SPEECH_POST_PROCESSING_PROMPT
              }
              onChange={(event) =>
                void updateClientSettings({
                  speechPostProcessingPrompt: {
                    mode: "custom",
                    customInstructions: event.target.value,
                  },
                })
              }
            />
          </SettingsRow>
        ) : null}
        {cleanupEnabled && settingsScope !== null ? <CleanupModelRow /> : null}
        {cleanupEnabled ? (
          <SettingsRow
            {...searchableSetting("speech-correction-word")}
            title="Correction cue"
            description="A word you say to flag a spoken correction, such as “sorry” or “scratch that”. Cleanup applies the correction only when the context shows one, and the model hears the cue as a hint."
            control={
              <Input
                key={settings.speechCorrectionWord}
                defaultValue={settings.speechCorrectionWord}
                maxLength={50}
                placeholder="sorry"
                aria-label="Correction cue"
                className="w-40"
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next !== settings.speechCorrectionWord)
                    void updateClientSettings({ speechCorrectionWord: next });
                }}
              />
            }
          />
        ) : null}
      </SettingsSection>

      {prepared ? (
        <EnvironmentModelsSection
          key={prepared.environmentId}
          prepared={prepared}
          status={modelStatus}
          onStatus={(connection, status) => setCatalog({ connection, status })}
        />
      ) : null}
      <SettingsSection id="voice-tests" title="Test">
        <SettingsRow
          {...searchableSetting("microphone-test")}
          title="Test microphone"
          description="Record up to ten seconds and play it back here. The audio stays in this browser and is never transcribed, so a silent playback means the microphone, not the model."
          control={<MicrophoneTest key={selectedMicrophone} microphoneId={selectedMicrophone} />}
        />
        {destination.environmentId ? (
          <TranscriptionTest
            environmentId={destination.environmentId}
            modelName={model?.model ?? null}
          />
        ) : (
          <p className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground sm:px-4">
            <MicIcon className="size-3.5" />
            Choose where to send microphone audio to test the model.
          </p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
