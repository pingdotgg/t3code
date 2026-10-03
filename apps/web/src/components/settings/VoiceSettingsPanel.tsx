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
import type {
  EnvironmentId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  SpeechAcceleration,
  SpeechCustomWords,
  SpeechModelUnloadTimeout,
} from "@t3tools/contracts";
import { SpeechCustomWords as SpeechCustomWordsSchema } from "@t3tools/contracts";
import { mergeSpeechCustomWords } from "@t3tools/shared/speech";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AudioLinesIcon,
  CheckIcon,
  DownloadIcon,
  GaugeIcon,
  GlobeIcon,
  HardDriveIcon,
  LanguagesIcon,
  RefreshCwIcon,
  TargetIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { runtime } from "../../lib/runtime";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { VoicePostProcessingSettings } from "./VoicePostProcessingSettings";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { MicrophoneTest } from "./MicrophoneTest";
import { TranscriptionTest } from "./TranscriptionTest";

const isSpeechCustomWords = Schema.is(SpeechCustomWordsSchema);

const SYSTEM_DEFAULT = "system-default";
const PRIMARY_ENVIRONMENT = "primary-environment";
const deviceValue = (id: string) => `device:${id}`;
const environmentValue = (id: EnvironmentId) => `environment:${id}`;
const formatSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const normalizeDictionaryTerm = (value: string) =>
  value
    .replace(/[<>"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
const prepareBulkWords = (draft: string, words: SpeechCustomWords) => {
  const seen = new Set(
    words.flatMap(({ term, aliases }) =>
      [term, ...aliases].map((value) => value.toLocaleLowerCase()),
    ),
  );
  const entries: SpeechCustomWords[number][] = [];
  let duplicates = 0;
  let tooLong = 0;
  let overLimit = 0;
  let invalid = 0;
  for (const line of draft.split(/\r\n?|\n/)) {
    if (!line.trim()) continue;
    const term = normalizeDictionaryTerm(line);
    if (!term) {
      invalid++;
      continue;
    }
    if (term.length > 50) {
      tooLong++;
      continue;
    }
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    if (words.length + entries.length >= 100) {
      overLimit++;
      continue;
    }
    entries.push({ term, aliases: [] });
  }
  return { entries, duplicates, tooLong, overLimit, invalid };
};
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
const languageLabel = (code: string) => (code === "all" ? "All" : (languageNames.of(code) ?? code));
// Ethnologue 2026 total speakers, for languages that map clearly to our model codes.
// https://en.wikipedia.org/wiki/List_of_languages_by_total_number_of_speakers#Ethnologue_(2026)
const rankedLanguageCodes = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "bn",
  "pt",
  "id",
  "ur",
  "ru",
  "de",
  "ja",
  "mr",
  "vi",
  "te",
  "sw",
  "ha",
  "tr",
  "tl",
  "ta",
  "jw",
  "ko",
  "am",
  "th",
  "it",
  "gu",
  "kn",
  "yo",
] as const;
const languageRanks = new Map<string, number>(
  rankedLanguageCodes.map((code, rank) => [code, rank]),
);
const compareLanguages = (a: string, b: string) => {
  const aRank = languageRanks.get(a);
  const bRank = languageRanks.get(b);
  if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
  if (aRank !== undefined) return -1;
  if (bRank !== undefined) return 1;
  return languageLabel(a).localeCompare(languageLabel(b));
};
// Handy's editorial model order (catalog dated 2026-08-17).
const modelRanks = new Map<string, number>(
  [
    "parakeet-unified-en-0.6b",
    "nemotron-3.5-asr-streaming-0.6b",
    "canary-180m-flash",
    "cohere-transcribe-03-2026",
    "whisper-medium",
    "Voxtral-Mini-4B-Realtime-2602",
    "parakeet-tdt-0.6b-v3",
    "parakeet-tdt-0.6b-v2",
    "Qwen3-ASR-0.6B",
    "Fun-ASR-MLT-Nano-2512",
  ].map((slug, index) => [`handy-computer/${slug}-gguf`, index + 1]),
);
const modelSortOrder = (model: EnvironmentSpeechModel) => {
  if (model.active) return 0;
  if (model.state === "installed") return 1;
  if (model.state === "downloading" || model.state === "verifying") return 2;
  return 3;
};

function ModelCard(props: {
  readonly model: EnvironmentSpeechModel;
  readonly busy: boolean;
  readonly failedDownload: boolean;
  readonly onDownload: () => void;
  readonly onSelect: () => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}) {
  const { model } = props;
  const downloading = model.state === "downloading" || model.state === "verifying";
  const progress = model.downloaded === undefined ? 0 : (model.downloaded / model.size) * 100;
  return (
    <div
      className={`rounded-lg border px-3 py-3 ${model.active ? "border-primary/40 bg-primary/5" : "border-border/70 bg-card/30"}`}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold leading-5">{model.name}</span>
            {model.recommended ? <Badge variant="outline">Recommended</Badge> : null}
            {model.supportsStreaming ? (
              <Badge variant="outline">
                <AudioLinesIcon className="mr-1 size-3" />
                Streaming
              </Badge>
            ) : null}
            {model.supportsTranslation ? (
              <Badge variant="outline">
                <LanguagesIcon className="mr-1 size-3" />
                Translate
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{model.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <GlobeIcon className="size-3" />
              {model.languages.length === 1
                ? languageLabel(model.languages[0]!)
                : `${model.languages.length} languages`}
            </span>
            <span className="inline-flex items-center gap-1">
              <HardDriveIcon className="size-3" />
              {formatSize(model.size)}
            </span>
            <span className="inline-flex items-center gap-1">
              <TargetIcon className="size-3" />
              Accuracy {model.accuracy}
            </span>
            <span className="inline-flex items-center gap-1">
              <GaugeIcon className="size-3" />
              Speed {model.speed}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {downloading ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Cancel ${model.name} download`}
              onClick={props.onCancel}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : model.state === "downloadable" ? (
            <Button size="sm" disabled={props.busy} onClick={props.onDownload}>
              <DownloadIcon className="mr-1.5 size-3.5" />
              {props.failedDownload ? "Retry download" : "Download"}
            </Button>
          ) : !model.active ? (
            <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onSelect}>
              Use model
            </Button>
          ) : (
            <Button size="sm" variant="secondary" disabled>
              <CheckIcon className="mr-1.5 size-3.5" />
              Selected
            </Button>
          )}
          {model.state === "installed" ? (
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={props.busy || downloading}
              aria-label={`Delete ${model.name}`}
              onClick={props.onDelete}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
      {downloading ? (
        <div className="mt-3">
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="mt-1 text-2xs text-muted-foreground">
            {model.state === "verifying"
              ? "Verifying download…"
              : `${Math.round(progress)}% downloaded`}
          </div>
        </div>
      ) : props.failedDownload && model.state === "downloadable" ? (
        <p role="status" className="mt-2 text-xs text-destructive">
          Download failed. Try again.
        </p>
      ) : null}
    </div>
  );
}

export function VoiceSettingsPanel() {
  const settingsScope = useOptionalSettingsScope();
  const projectId =
    settingsScope?.target?.projectId ??
    (settingsScope?.scope.kind === "project" || settingsScope?.scope.kind === "checkout"
      ? settingsScope.scope.members[0]?.id
      : undefined);
  const projectLabel = settingsScope?.scope.label ?? "this project";
  const clientSettingsHydrated = useClientSettingsHydrated();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const selectedEnvironmentId = useClientSettings(
    (settings) => settings.voiceTranscriptionEnvironmentId,
  );
  const environmentId = clientSettingsHydrated
    ? (selectedEnvironmentId ?? primaryEnvironmentId)
    : null;
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const selectedMicrophone = useClientSettings((settings) => settings.voiceMicrophone);
  const voiceShortcutMode = useClientSettings((settings) => settings.voiceShortcutMode);
  const updateClientSettings = useUpdateClientSettings();
  const clientSettings = useClientSettings();
  const scopedSettings = useScopedSettings();
  const updateScopedSettings = useUpdateScopedSettings();
  const [status, setStatus] = useState<{
    readonly prepared: NonNullable<typeof prepared>;
    readonly value: EnvironmentSpeechStatus;
  } | null>(null);
  const [models, setModels] = useState<readonly EnvironmentSpeechModel[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [loadingMicrophones, setLoadingMicrophones] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [failedDownloads, setFailedDownloads] = useState<{
    prepared: NonNullable<typeof prepared>;
    modelIds: ReadonlySet<string>;
  } | null>(null);
  const [customWordDraft, setCustomWordDraft] = useState("");
  const [bulkWordsDraft, setBulkWordsDraft] = useState("");
  const [bulkWordsOpen, setBulkWordsOpen] = useState(false);
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  const [languageSearch, setLanguageSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState<{
    readonly environmentId: EnvironmentId | null;
    readonly code: string;
  } | null>(null);

  const refreshMicrophones = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    setLoadingMicrophones(true);
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicrophones(devices.filter((device) => device.kind === "audioinput"));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not list microphones",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoadingMicrophones(false);
    }
  }, []);

  const connectionEpoch = useRef<{ prepared: typeof prepared } | null>(null);
  useLayoutEffect(() => {
    connectionEpoch.current = { prepared };
    return () => {
      connectionEpoch.current = null;
    };
  }, [prepared]);

  const refreshModels = useCallback(async () => {
    if (!prepared) return;
    const epoch = connectionEpoch.current;
    if (epoch?.prepared !== prepared) return;
    try {
      const [nextStatus, nextModels] = await Promise.all([
        runtime.runPromise(getEnvironmentSpeechStatus(prepared)),
        runtime.runPromise(getEnvironmentSpeechModels(prepared)),
      ]);
      if (connectionEpoch.current !== epoch) return;
      setStatus({ prepared, value: nextStatus });
      setModels(nextModels.models);
    } catch (error) {
      if (connectionEpoch.current !== epoch) return;
      throw error;
    }
  }, [prepared]);

  useEffect(() => {
    void refreshMicrophones();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) return;
    const handleDeviceChange = () => void refreshMicrophones();
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [refreshMicrophones]);

  useEffect(() => {
    void refreshModels().catch(() => {
      setStatus(null);
      setModels([]);
    });
  }, [refreshModels]);
  useEffect(() => {
    if (!operation) return;
    let refreshInFlight = false;
    const timer = window.setInterval(() => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      void refreshModels()
        .catch(() => undefined)
        .finally(() => {
          refreshInFlight = false;
        });
    }, 350);
    return () => window.clearInterval(timer);
  }, [operation, refreshModels]);

  const reportModelError = (error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Could not update transcription model",
      description: error instanceof Error ? error.message : String(error),
    });
  };
  const markDownloadFailed = (modelId: string, failed: boolean) => {
    if (!prepared) return;
    setFailedDownloads((current) => {
      const modelIds = new Set(current?.prepared === prepared ? current.modelIds : []);
      if (failed) modelIds.add(modelId);
      else modelIds.delete(modelId);
      return { prepared, modelIds };
    });
  };
  const runModelOperation = (modelId: string, run: () => Promise<unknown>, kind?: "download") => {
    if (kind === "download") markDownloadFailed(modelId, false);
    setOperation(modelId);
    void run()
      .then(refreshModels)
      .catch((error) => {
        if (kind === "download") markDownloadFailed(modelId, true);
        reportModelError(error);
      })
      .finally(() => setOperation(null));
  };
  const selectedIsUnavailable = Boolean(
    selectedMicrophone && !microphones.some((device) => device.deviceId === selectedMicrophone),
  );
  const unavailableSelectedEnvironmentId =
    selectedEnvironmentId !== null &&
    !environments.some((environment) => environment.environmentId === selectedEnvironmentId)
      ? selectedEnvironmentId
      : null;
  const primaryEnvironment = environments.find(
    (environment) => environment.environmentId === primaryEnvironmentId,
  );
  const selectedEnvironmentLabel = selectedEnvironmentId
    ? (environments.find((environment) => environment.environmentId === selectedEnvironmentId)
        ?.label ?? "Selected environment (Unavailable)")
    : primaryEnvironment
      ? `${primaryEnvironment.label} (Primary)`
      : "Primary environment";
  const selectedMicrophoneLabel = selectedMicrophone
    ? (microphones.find((device) => device.deviceId === selectedMicrophone)?.label ??
      "Selected microphone (Unavailable)")
    : "System default";
  const currentStatus = status?.prepared === prepared ? status.value : null;
  const acceptStatus = (value: EnvironmentSpeechStatus) => {
    if (prepared) setStatus({ prepared, value });
  };
  const personalWords = clientSettings.speechCustomWords;
  const projectWords = projectId ? scopedSettings.speechProjectCustomWords : [];
  const editableWords = projectId ? projectWords : personalWords;
  const personalSpellings = new Set(
    personalWords.flatMap(({ term, aliases }) =>
      [term, ...aliases].map((value) => value.toLocaleLowerCase()),
    ),
  );
  const customWords = mergeSpeechCustomWords(personalWords, projectWords);
  const dictionaryUnavailable =
    !clientSettingsHydrated ||
    Boolean(projectId && (settingsScope?.scope.kind === "unavailable" || !settingsScope?.target));
  const removeFillerWords = clientSettings.speechRemoveFillerWords;
  const acceleration = currentStatus?.supported ? currentStatus.acceleration : "auto";
  const modelUnloadTimeout = currentStatus?.supported ? currentStatus.modelUnloadTimeout : "min_15";
  const gpuDevices = currentStatus?.supported ? currentStatus.gpuDevices : [];
  const normalizedCustomWord = normalizeDictionaryTerm(customWordDraft);
  const bulkWords = prepareBulkWords(bulkWordsDraft, customWords);
  const updateCustomWords = (words: SpeechCustomWords, onSuccess?: () => void) => {
    if (dictionaryUnavailable) return;
    const dictionary = projectId ? mergeSpeechCustomWords(personalWords, words) : words;
    if (!isSpeechCustomWords(dictionary)) {
      toastManager.add({
        type: "error",
        title: "Could not update dictionary",
        description:
          "Personal and project dictionaries together cannot exceed 100 words. Terms and aliases must be unique.",
      });
      return;
    }
    if (projectId) {
      updateScopedSettings({ speechProjectCustomWords: words });
      onSuccess?.();
    } else {
      void updateClientSettings({ speechCustomWords: words })
        .then(onSuccess)
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not update dictionary",
            description: error instanceof Error ? error.message : String(error),
          });
        });
    }
  };
  const addCustomWord = () => {
    if (
      !normalizedCustomWord ||
      normalizedCustomWord.length > 50 ||
      customWords.length >= 100 ||
      customWords.some(({ term, aliases }) =>
        [term, ...aliases].some(
          (spelling) => spelling.toLocaleLowerCase() === normalizedCustomWord.toLocaleLowerCase(),
        ),
      )
    )
      return;
    updateCustomWords([...editableWords, { term: normalizedCustomWord, aliases: [] }], () =>
      setCustomWordDraft(""),
    );
  };
  const addBulkWords = () => {
    if (dictionaryUnavailable || operation !== null || bulkWords.entries.length === 0) return;
    updateCustomWords([...editableWords, ...bulkWords.entries], () => {
      setBulkWordsDraft("");
      setBulkWordsOpen(false);
    });
  };
  const addAlias = (term: string, draft: string) => {
    updateCustomWords(
      editableWords.map((entry) =>
        entry.term === term ? { ...entry, aliases: [...entry.aliases, draft] } : entry,
      ),
      () => setAliasDrafts((drafts) => ({ ...drafts, [term]: "" })),
    );
  };
  const currentModels = currentStatus?.supported ? models : [];
  const activeModel = currentModels.find((model) => model.active);
  const languages = [...new Set(currentModels.flatMap((model) => model.languages))].sort(
    compareLanguages,
  );
  const languageOptions = ["all", ...languages];
  const searchTerm = languageSearch.trim().toLocaleLowerCase();
  const matchingLanguages = searchTerm
    ? languageOptions.filter(
        (code) =>
          code.toLocaleLowerCase().includes(searchTerm) ||
          languageLabel(code).toLocaleLowerCase().includes(searchTerm),
      )
    : languageOptions;
  const language =
    selectedLanguage?.environmentId === environmentId &&
    languageOptions.includes(selectedLanguage.code)
      ? selectedLanguage.code
      : (activeModel?.languages[0] ?? languages[0]);
  const modelsForLanguage =
    language === "all"
      ? currentModels
      : currentModels.filter((model) => model.languages.includes(language ?? ""));
  const modelSearchTerm = modelSearch.trim().toLocaleLowerCase();
  const visibleModels = modelsForLanguage
    .filter(
      (model) =>
        !modelSearchTerm ||
        `${model.name} ${model.description}`.toLocaleLowerCase().includes(modelSearchTerm),
    )
    .sort(
      (a, b) =>
        modelSortOrder(a) - modelSortOrder(b) ||
        (modelRanks.get(a.id) ?? 11) - (modelRanks.get(b.id) ?? 11) ||
        Number(b.recommended) - Number(a.recommended) ||
        b.accuracy - a.accuracy ||
        b.speed - a.speed ||
        a.name.localeCompare(b.name),
    );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Input">
        <MicrophoneTest
          key={selectedMicrophone}
          microphoneId={selectedMicrophone}
          description={
            selectedIsUnavailable
              ? "The selected microphone is unavailable. Select another microphone to record."
              : "Choose the microphone used by this browser or app."
          }
          microphoneControl={
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <Select
                value={selectedMicrophone ? deviceValue(selectedMicrophone) : SYSTEM_DEFAULT}
                disabled={loadingMicrophones}
                onValueChange={(value) => {
                  if (value)
                    updateClientSettings({
                      voiceMicrophone:
                        value === SYSTEM_DEFAULT ? "" : value.slice("device:".length),
                    });
                }}
              >
                <SelectTrigger size="sm" aria-label="Microphone" className="min-w-0 flex-1">
                  <SelectValue
                    placeholder={loadingMicrophones ? "Finding microphones…" : "Microphone"}
                  >
                    {selectedMicrophoneLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={SYSTEM_DEFAULT}>System default</SelectItem>
                  {selectedIsUnavailable ? (
                    <SelectItem value={deviceValue(selectedMicrophone)}>
                      Selected microphone (Unavailable)
                    </SelectItem>
                  ) : null}
                  {microphones.map((device, index) => (
                    <SelectItem key={device.deviceId} value={deviceValue(device.deviceId)}>
                      {device.label || `Microphone ${index + 1}`}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={loadingMicrophones}
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
          description="Choose how the dictation shortcut starts and finishes recording. Change the shortcut in Keybindings settings."
          control={
            <Select
              value={voiceShortcutMode}
              onValueChange={(value) => {
                if (value === "auto" || value === "hold" || value === "toggle") {
                  void updateClientSettings({ voiceShortcutMode: value });
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Dictation shortcut mode" className="max-w-80">
                <SelectValue>
                  {voiceShortcutMode === "auto"
                    ? "Auto (hold or tap)"
                    : voiceShortcutMode === "hold"
                      ? "Hold to record"
                      : "Toggle recording"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="auto">Auto (hold or tap)</SelectItem>
                <SelectItem value="hold">Hold to record</SelectItem>
                <SelectItem value="toggle">Toggle recording</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      <SettingsSection title="Transcription" id={searchableSetting("local-voice-input").id}>
        <SettingsRow
          {...searchableSetting("transcription-environment")}
          description="Choose where voice transcription runs for every thread."
          control={
            <Select
              disabled={!clientSettingsHydrated || operation !== null}
              value={
                selectedEnvironmentId
                  ? environmentValue(selectedEnvironmentId)
                  : PRIMARY_ENVIRONMENT
              }
              onValueChange={(value) => {
                if (!value) return;
                if (value === PRIMARY_ENVIRONMENT) {
                  void updateClientSettings({ voiceTranscriptionEnvironmentId: null });
                  return;
                }
                const selectedEnvironment = environments.find(
                  (environment) => environmentValue(environment.environmentId) === value,
                );
                if (selectedEnvironment)
                  void updateClientSettings({
                    voiceTranscriptionEnvironmentId: selectedEnvironment.environmentId,
                  });
              }}
            >
              <SelectTrigger size="sm" aria-label="Transcription environment" className="max-w-80">
                <SelectValue>{selectedEnvironmentLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={PRIMARY_ENVIRONMENT}>
                  {primaryEnvironment
                    ? `${primaryEnvironment.label} (Primary)`
                    : "Primary environment"}
                </SelectItem>
                {unavailableSelectedEnvironmentId !== null ? (
                  <SelectItem value={environmentValue(unavailableSelectedEnvironmentId)}>
                    Selected environment (Unavailable)
                  </SelectItem>
                ) : null}
                {environments
                  .filter((environment) => environment.environmentId !== primaryEnvironmentId)
                  .map((environment) => (
                    <SelectItem
                      key={environment.environmentId}
                      value={environmentValue(environment.environmentId)}
                    >
                      {environment.label}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
          }
        />
        <TranscriptionTest
          key={`${environmentId}:${activeModel?.id}:${selectedMicrophone}`}
          prepared={prepared}
          microphoneId={selectedMicrophone}
          options={{
            speechLanguage: clientSettings.speechLanguage,
            speechTranslateToEnglish: clientSettings.speechTranslateToEnglish,
            speechCustomWords: customWords,
            speechRemoveFillerWords: removeFillerWords,
            speechCorrectionWord: clientSettings.speechCorrectionWord,
            speechPostProcessingEnabled: false,
          }}
          modelName={
            currentStatus?.supported ? (activeModel?.name ?? "No model selected") : "Unavailable"
          }
          disabled={
            !currentStatus?.supported ||
            !activeModel ||
            dictionaryUnavailable ||
            !isSpeechCustomWords(customWords) ||
            operation !== null
          }
        />
        <SettingsRow
          title="Transcription language"
          description={
            !activeModel
              ? "Select a model to choose a transcription language."
              : activeModel.languages.length === 1
                ? `This model only supports ${languageLabel(activeModel.languages[0]!)}.`
                : activeModel.supportsLanguageDetection
                  ? "Choose a language or let the model detect it from your speech."
                  : "This model cannot detect language automatically. Choose the language you speak."
          }
          control={
            <Select
              disabled={
                !prepared ||
                !activeModel ||
                activeModel.languages.length === 1 ||
                operation !== null
              }
              value={clientSettings.speechLanguage}
              onValueChange={(value) => {
                if (value) void updateClientSettings({ speechLanguage: value });
              }}
            >
              <SelectTrigger size="sm" aria-label="Transcription language" className="max-w-80">
                <SelectValue>
                  {clientSettings.speechLanguage === "auto"
                    ? "Auto"
                    : languageLabel(clientSettings.speechLanguage)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="auto">Auto</SelectItem>
                {clientSettings.speechLanguage !== "auto" &&
                !activeModel?.languages.includes(clientSettings.speechLanguage) ? (
                  <SelectItem value={clientSettings.speechLanguage}>
                    {languageLabel(clientSettings.speechLanguage)} (Unavailable on this model)
                  </SelectItem>
                ) : null}
                {[...(activeModel?.languages ?? [])].sort(compareLanguages).map((code) => (
                  <SelectItem key={code} value={code}>
                    {languageLabel(code)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Translate to English"
          description={
            !currentStatus?.supported || !currentStatus.supportsTranslation
              ? "The active model does not support translation."
              : clientSettings.speechLanguage === "en"
                ? "English speech is transcribed without translation."
                : "Convert speech in the selected or detected language directly into English text."
          }
          control={
            <Switch
              aria-label="Translate to English"
              checked={clientSettings.speechTranslateToEnglish}
              disabled={
                !prepared ||
                !currentStatus?.supported ||
                !currentStatus.supportsTranslation ||
                operation !== null
              }
              onCheckedChange={(enabled) => {
                void updateClientSettings({ speechTranslateToEnglish: enabled });
              }}
            />
          }
        />
        {currentStatus?.supported && prepared ? (
          <div className="flex h-80 min-h-0 flex-col border-t border-border/50 sm:flex-row">
            <div className="flex min-h-0 shrink-0 flex-col border-b border-border/50 bg-muted/20 sm:w-44 sm:border-r sm:border-b-0">
              <div className="flex items-center gap-1 p-2 sm:flex-col sm:items-stretch sm:gap-2 sm:p-3">
                <span className="hidden text-xs text-muted-foreground sm:block">Language</span>
                <div className="flex min-w-0 flex-1 items-center gap-1 sm:flex-none">
                  <Input
                    type="search"
                    size="compact"
                    aria-label="Search languages"
                    placeholder="Search languages"
                    value={languageSearch}
                    onChange={(event) => setLanguageSearch(event.target.value)}
                  />
                  {languageSearch ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Clear language search"
                      onClick={() => setLanguageSearch("")}
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
              <div
                role="group"
                aria-label="Browse transcription models by language"
                className="flex min-h-0 gap-1 overflow-x-auto px-2 pb-2 sm:flex-1 sm:flex-col sm:overflow-y-auto"
              >
                {matchingLanguages.map((code) => (
                  <button
                    key={code}
                    type="button"
                    aria-pressed={language === code}
                    className={`shrink-0 rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/50 ${language === code ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                    onClick={() => setSelectedLanguage({ environmentId, code })}
                  >
                    {languageLabel(code)}
                  </button>
                ))}
                {matchingLanguages.length === 0 ? (
                  <p className="px-2.5 py-2 text-xs text-muted-foreground">No languages found</p>
                ) : null}
              </div>
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="space-y-2 p-3">
                <p className="text-xs text-muted-foreground">
                  {language === "all"
                    ? "All models"
                    : `Models for ${language ? languageLabel(language) : "this environment"}`}
                </p>
                <div className="flex items-center gap-1">
                  <Input
                    type="search"
                    size="compact"
                    aria-label="Search transcription models"
                    placeholder="Search models"
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                  />
                  {modelSearch ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Clear model search"
                      onClick={() => setModelSearch("")}
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                {visibleModels.map((model) => (
                  <ModelCard
                    key={model.id}
                    model={model}
                    busy={operation !== null}
                    failedDownload={
                      failedDownloads?.prepared === prepared &&
                      failedDownloads.modelIds.has(model.id)
                    }
                    onDownload={() =>
                      runModelOperation(
                        model.id,
                        async () => {
                          const result = await runtime.runPromise(
                            downloadEnvironmentSpeechModel(prepared, model.id),
                          );
                          if (
                            result.models.some(
                              (candidate) =>
                                candidate.id === model.id && candidate.state === "installed",
                            )
                          ) {
                            await runtime.runPromise(
                              selectEnvironmentSpeechModel(prepared, model.id),
                            );
                          }
                        },
                        "download",
                      )
                    }
                    onSelect={() =>
                      runModelOperation(model.id, () =>
                        runtime.runPromise(selectEnvironmentSpeechModel(prepared, model.id)),
                      )
                    }
                    onCancel={() =>
                      void runtime
                        .runPromise(cancelEnvironmentSpeechModelDownload(prepared, model.id))
                        .then(refreshModels)
                        .catch(reportModelError)
                    }
                    onDelete={() =>
                      void ensureLocalApi()
                        .dialogs.confirm(`Delete ${model.name} from this T3 environment?`)
                        .then((confirmed) => {
                          if (confirmed)
                            runModelOperation(model.id, () =>
                              runtime.runPromise(removeEnvironmentSpeechModel(prepared, model.id)),
                            );
                        })
                    }
                  />
                ))}
                {modelsForLanguage.length === 0 ? (
                  <p className="py-8 text-center text-xs text-muted-foreground">
                    No transcription models are available.
                  </p>
                ) : visibleModels.length === 0 ? (
                  <p className="py-8 text-center text-xs text-muted-foreground">
                    No models match your search.
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <p className="border-t border-border/50 px-4 py-4 text-xs text-muted-foreground">
            {currentStatus && !currentStatus.supported
              ? currentStatus.reason
              : "Connect to a current T3 environment to manage transcription models."}
          </p>
        )}
      </SettingsSection>
      <SettingsSection title="Transcription options">
        <SettingsRow
          {...searchableSetting("dictionary")}
          serverScoped={Boolean(projectId)}
          settingKeys={projectId ? ["speechProjectCustomWords"] : []}
          title="Dictionary"
          description={
            projectId
              ? "Project words are saved on the selected project environments. Your personal words are included automatically."
              : "Personal words are saved on this client and used across projects and transcription environments."
          }
          control={
            <div className="w-full max-w-80">
              <div className="flex items-center gap-1.5">
                <Input
                  value={customWordDraft}
                  maxLength={50}
                  placeholder="Add a word or phrase"
                  aria-label="Add a word or phrase"
                  disabled={dictionaryUnavailable || operation !== null}
                  onChange={(event) => setCustomWordDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addCustomWord();
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    dictionaryUnavailable ||
                    !normalizedCustomWord ||
                    normalizedCustomWord.length > 50 ||
                    customWords.some(({ term, aliases }) =>
                      [term, ...aliases].some(
                        (spelling) =>
                          spelling.toLocaleLowerCase() === normalizedCustomWord.toLocaleLowerCase(),
                      ),
                    ) ||
                    customWords.length >= 100 ||
                    operation !== null
                  }
                  onClick={addCustomWord}
                >
                  Add
                </Button>
              </div>
              {projectId &&
              normalizedCustomWord &&
              personalSpellings.has(normalizedCustomWord.toLocaleLowerCase()) ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Already in your personal dictionary.
                </p>
              ) : null}
              <div className="mt-1 flex justify-end">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  disabled={dictionaryUnavailable || operation !== null}
                  aria-expanded={bulkWordsOpen}
                  onClick={() => setBulkWordsOpen((open) => !open)}
                >
                  {bulkWordsOpen ? "Hide bulk entry" : "Add multiple words"}
                </Button>
              </div>
            </div>
          }
        >
          {bulkWordsOpen ? (
            <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
              <p className="text-xs text-muted-foreground">Paste one word or phrase per line.</p>
              <Textarea
                value={bulkWordsDraft}
                maxLength={10_000}
                placeholder={"T3 Code\nAnother name\nTechnical term"}
                aria-label="Words to add"
                disabled={dictionaryUnavailable || operation !== null}
                onChange={(event) => setBulkWordsDraft(event.target.value)}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p role="status" className="text-xs text-muted-foreground">
                  {bulkWords.entries.length} {bulkWords.entries.length === 1 ? "word" : "words"}{" "}
                  ready to add
                  {bulkWords.duplicates > 0
                    ? ` · ${bulkWords.duplicates} duplicate${bulkWords.duplicates === 1 ? "" : "s"}`
                    : ""}
                  {bulkWords.tooLong > 0 ? ` · ${bulkWords.tooLong} over 50 characters` : ""}
                  {bulkWords.overLimit > 0
                    ? ` · ${bulkWords.overLimit} over the 100-word limit`
                    : ""}
                  {bulkWords.invalid > 0 ? ` · ${bulkWords.invalid} empty after cleanup` : ""}
                </p>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    dictionaryUnavailable || bulkWords.entries.length === 0 || operation !== null
                  }
                  onClick={addBulkWords}
                >
                  Add {bulkWords.entries.length} {bulkWords.entries.length === 1 ? "word" : "words"}
                </Button>
              </div>
            </div>
          ) : null}
          {customWords.length > 0 ? (
            <div className="mt-3 border-t border-border/60 pt-3">
              <p className="mb-2 text-xs text-muted-foreground">
                Click a word to correct its misspellings.
              </p>
              <div aria-label="Dictionary entries" className="flex flex-wrap gap-1.5">
                {customWords.map(({ term, aliases }) => {
                  const inherited = Boolean(
                    projectId && !projectWords.some((entry) => entry.term === term),
                  );
                  const draft = (aliasDrafts[term] ?? "")
                    .replace(/[<>"']/g, "")
                    .replace(/\s+/g, " ")
                    .trim();
                  const used = customWords.some((entry) =>
                    [entry.term, ...entry.aliases].some(
                      (spelling) => spelling.toLocaleLowerCase() === draft.toLocaleLowerCase(),
                    ),
                  );
                  return (
                    <Popover key={term}>
                      <PopoverTrigger
                        render={<Button type="button" size="xs" variant="secondary" />}
                        aria-label={`${inherited ? "View" : "Edit"} misspellings for ${term}`}
                      >
                        {term}
                        {aliases.length > 0 ? (
                          <span className="text-muted-foreground">({aliases.length})</span>
                        ) : null}
                      </PopoverTrigger>
                      <PopoverContent align="start" sideOffset={6} width="md">
                        <div className="mb-3 flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">{term}</span>
                          {!inherited ? (
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost-muted"
                              disabled={operation !== null}
                              aria-label={`Remove ${term}`}
                              onClick={() =>
                                updateCustomWords(
                                  editableWords.filter((item) => item.term !== term),
                                )
                              }
                            >
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          ) : null}
                        </div>
                        <p className="mb-3 text-xs text-muted-foreground">
                          {inherited || !projectId
                            ? "Shared across all projects"
                            : `Only used in ${projectLabel}`}
                        </p>
                        <div className="space-y-2">
                          {!inherited ? (
                            <p className="text-xs text-muted-foreground">
                              Add common misspellings to correct them to {term} in the transcript.
                            </p>
                          ) : null}
                          {aliases.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {aliases.map((alias) =>
                                inherited ? (
                                  <Badge key={alias} variant="outline">
                                    {alias}
                                  </Badge>
                                ) : (
                                  <Button
                                    key={alias}
                                    type="button"
                                    size="xs"
                                    variant="secondary"
                                    disabled={operation !== null}
                                    aria-label={`Remove alias ${alias} from ${term}`}
                                    onClick={() =>
                                      updateCustomWords(
                                        editableWords.map((entry) =>
                                          entry.term === term
                                            ? {
                                                ...entry,
                                                aliases: entry.aliases.filter(
                                                  (value) => value !== alias,
                                                ),
                                              }
                                            : entry,
                                        ),
                                      )
                                    }
                                  >
                                    {alias}
                                    <XIcon className="ml-1 size-3" />
                                  </Button>
                                ),
                              )}
                            </div>
                          ) : null}
                          {inherited ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                settingsScope?.selectScope({
                                  ...settingsScope.search,
                                  project: undefined,
                                  checkout: undefined,
                                })
                              }
                            >
                              Edit personal dictionary
                            </Button>
                          ) : (
                            <div className="flex max-w-80 gap-1.5">
                              <Input
                                value={aliasDrafts[term] ?? ""}
                                maxLength={50}
                                placeholder="Common mis-transcription"
                                aria-label={`Transcribed as for ${term}`}
                                disabled={operation !== null || aliases.length >= 8}
                                onChange={(event) =>
                                  setAliasDrafts((drafts) => ({
                                    ...drafts,
                                    [term]: event.target.value,
                                  }))
                                }
                                onKeyDown={(event) => {
                                  if (
                                    event.key !== "Enter" ||
                                    !draft ||
                                    used ||
                                    aliases.length >= 8 ||
                                    operation !== null
                                  )
                                    return;
                                  event.preventDefault();
                                  addAlias(term, draft);
                                }}
                              />
                              <Button
                                type="button"
                                size="sm"
                                disabled={
                                  !draft || used || aliases.length >= 8 || operation !== null
                                }
                                onClick={() => addAlias(term, draft)}
                              >
                                Add
                              </Button>
                            </div>
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                  );
                })}
              </div>
            </div>
          ) : null}
        </SettingsRow>
        <SettingsRow
          {...searchableSetting("remove-filler-words")}
          description="Remove common hesitation words while preserving ambiguous words in multilingual transcription."
          control={
            <Switch
              aria-label="Remove filler words"
              checked={removeFillerWords}
              disabled={!clientSettingsHydrated}
              onCheckedChange={(enabled) => {
                void updateClientSettings({ speechRemoveFillerWords: enabled });
              }}
            />
          }
        />
      </SettingsSection>
      <VoicePostProcessingSettings />
      <SettingsSection title="Advanced">
        <SettingsRow
          {...searchableSetting("speech-model-unload")}
          description="Unload the model after it has been idle on the selected environment. Never keeps it loaded until that environment stops."
          control={
            <Select
              value={modelUnloadTimeout}
              disabled={!currentStatus?.supported || operation !== null}
              onValueChange={(value) => {
                if (!prepared || !value) return;
                setOperation("model-unload");
                void runtime
                  .runPromise(
                    updateEnvironmentSpeechModelUnloadTimeout(
                      prepared,
                      value as SpeechModelUnloadTimeout,
                    ),
                  )
                  .then(acceptStatus)
                  .catch((error) => {
                    toastManager.add({
                      type: "error",
                      title: "Could not update model unload setting",
                      description: error instanceof Error ? error.message : String(error),
                    });
                  })
                  .finally(() => setOperation(null));
              }}
            >
              <SelectTrigger size="sm" aria-label="Model unload" className="max-w-80">
                <SelectValue>
                  {
                    {
                      never: "Never",
                      immediately: "Immediately",
                      min_2: "2 minutes",
                      min_5: "5 minutes",
                      min_10: "10 minutes",
                      min_15: "15 minutes",
                      hour_1: "1 hour",
                    }[modelUnloadTimeout]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="never">Never</SelectItem>
                <SelectItem value="immediately">Immediately</SelectItem>
                <SelectItem value="min_2">2 minutes</SelectItem>
                <SelectItem value="min_5">5 minutes</SelectItem>
                <SelectItem value="min_10">10 minutes</SelectItem>
                <SelectItem value="min_15">15 minutes</SelectItem>
                <SelectItem value="hour_1">1 hour</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("speech-acceleration")}
          description="Choose where transcription runs on the selected environment. Auto uses a GPU when available."
          control={
            <Select
              value={acceleration}
              disabled={!currentStatus?.supported || operation !== null}
              onValueChange={(value) => {
                if (!prepared || !value) return;
                setOperation("acceleration");
                void runtime
                  .runPromise(
                    updateEnvironmentSpeechAcceleration(prepared, value as SpeechAcceleration),
                  )
                  .then(acceptStatus)
                  .catch((error) => {
                    toastManager.add({
                      type: "error",
                      title: "Could not update acceleration",
                      description: error instanceof Error ? error.message : String(error),
                    });
                  })
                  .finally(() => setOperation(null));
              }}
            >
              <SelectTrigger size="sm" aria-label="Transcription acceleration" className="max-w-80">
                <SelectValue>
                  {acceleration === "auto"
                    ? "Auto"
                    : acceleration === "cpu"
                      ? "CPU"
                      : (gpuDevices.find((device) => `gpu:${device.id}` === acceleration)?.name ??
                        "Selected GPU (Unavailable)")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="auto">Auto</SelectItem>
                {acceleration.startsWith("gpu:") &&
                !gpuDevices.some((device) => `gpu:${device.id}` === acceleration) ? (
                  <SelectItem value={acceleration}>Selected GPU (Unavailable)</SelectItem>
                ) : null}
                {gpuDevices.map((device) => (
                  <SelectItem key={device.id} value={`gpu:${device.id}`}>
                    {device.name}
                  </SelectItem>
                ))}
                <SelectItem value="cpu">CPU</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
