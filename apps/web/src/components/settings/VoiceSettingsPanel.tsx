import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  removeEnvironmentSpeechModel,
  selectEnvironmentSpeechModel,
  updateEnvironmentSpeechCustomWords,
  updateEnvironmentSpeechFillerWordRemoval,
  updateEnvironmentSpeechAcceleration,
} from "@t3tools/client-runtime/voice-input";
import type {
  EnvironmentId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  SpeechAcceleration,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { CheckIcon, DownloadIcon, GlobeIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { VoicePostProcessingSettings } from "./VoicePostProcessingSettings";

const SYSTEM_DEFAULT = "system-default";
const PRIMARY_ENVIRONMENT = "primary-environment";
const deviceValue = (id: string) => `device:${id}`;
const environmentValue = (id: EnvironmentId) => `environment:${id}`;
const formatSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
const languageLabel = (code: string) => languageNames.of(code) ?? code;

function ModelCard(props: {
  readonly model: EnvironmentSpeechModel;
  readonly busy: boolean;
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
      className={`rounded-lg border px-3 py-2.5 ${model.active ? "border-accent/50 bg-accent/5" : "border-border/70 bg-card/30"}`}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{model.name}</span>
            {model.active ? (
              <Badge variant="secondary">
                <CheckIcon className="mr-1 size-3" />
                Active
              </Badge>
            ) : null}
            {model.recommended ? <Badge variant="outline">Recommended</Badge> : null}
            {model.supportsStreaming ? <Badge variant="outline">Streaming</Badge> : null}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{model.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <GlobeIcon className="size-3" />
              {model.languages.length === 1
                ? languageLabel(model.languages[0]!)
                : `${model.languages.length} languages`}
            </span>
            <span>{formatSize(model.size)}</span>
            <span>Accuracy {model.accuracy}</span>
            <span>Speed {model.speed}</span>
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
              Download
            </Button>
          ) : !model.active ? (
            <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onSelect}>
              Use model
            </Button>
          ) : null}
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
          <div className="mt-1 text-[11px] text-muted-foreground">
            {model.state === "verifying"
              ? "Verifying download…"
              : `${Math.round(progress)}% downloaded`}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function VoiceSettingsPanel() {
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
  const updateClientSettings = useUpdateClientSettings();
  const [status, setStatus] = useState<{
    readonly prepared: NonNullable<typeof prepared>;
    readonly value: EnvironmentSpeechStatus;
  } | null>(null);
  const [models, setModels] = useState<readonly EnvironmentSpeechModel[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [loadingMicrophones, setLoadingMicrophones] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [customWordDraft, setCustomWordDraft] = useState("");
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
  const runModelOperation = (modelId: string, run: () => Promise<unknown>) => {
    setOperation(modelId);
    void run()
      .then(refreshModels)
      .catch(reportModelError)
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
  const customWords = currentStatus?.supported ? (currentStatus.customWords ?? []) : [];
  const removeFillerWords = currentStatus?.supported
    ? (currentStatus.removeFillerWords ?? true)
    : true;
  const acceleration = currentStatus?.supported ? (currentStatus.acceleration ?? "auto") : "auto";
  const gpuDevices = currentStatus?.supported ? (currentStatus.gpuDevices ?? []) : [];
  const normalizedCustomWord = customWordDraft
    .replace(/[<>"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const updateCustomWords = (words: readonly string[]) => {
    if (!prepared) return;
    setOperation("custom-words");
    void runtime
      .runPromise(updateEnvironmentSpeechCustomWords(prepared, words))
      .then((value) => setStatus({ prepared, value }))
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not update dictionary",
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setOperation(null));
  };
  const addCustomWord = () => {
    if (
      !normalizedCustomWord ||
      normalizedCustomWord.length > 50 ||
      customWords.includes(normalizedCustomWord)
    )
      return;
    updateCustomWords([...customWords, normalizedCustomWord]);
    setCustomWordDraft("");
  };
  const currentModels = currentStatus?.supported ? models : [];
  const activeModel = currentModels.find((model) => model.active);
  const languages = [...new Set(currentModels.flatMap((model) => model.languages))].sort((a, b) =>
    languageLabel(a).localeCompare(languageLabel(b)),
  );
  const language =
    selectedLanguage?.environmentId === environmentId && languages.includes(selectedLanguage.code)
      ? selectedLanguage.code
      : (activeModel?.languages[0] ?? languages[0]);
  const visibleModels = currentModels.filter((model) => model.languages.includes(language ?? ""));

  return (
    <SettingsPageContainer>
      <SettingsSection title="Input">
        <SettingsRow
          {...searchableSetting("transcription-environment")}
          description="Run voice transcription on this environment for every thread."
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
        <SettingsRow
          {...searchableSetting("microphone")}
          description={
            selectedIsUnavailable
              ? "The selected microphone is unavailable. Select another microphone to record."
              : "Choose the microphone used by this browser or app."
          }
          control={
            <div className="flex w-full max-w-80 items-center gap-1.5">
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
      </SettingsSection>
      <SettingsSection title="Transcription models" id={searchableSetting("local-voice-input").id}>
        <SettingsRow
          title="Active model"
          description="Models run on the selected environment. Recordings are deleted after transcription."
          control={
            <span className="text-sm text-muted-foreground">
              {currentStatus?.supported
                ? (activeModel?.name ?? "No model selected")
                : "Unavailable"}
            </span>
          }
        />
        {currentStatus?.supported && prepared ? (
          <div className="flex h-80 min-h-0 flex-col border-t border-border/50 sm:flex-row">
            <div
              role="group"
              aria-label="Browse transcription models by language"
              className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/50 bg-muted/20 p-2 sm:w-40 sm:flex-col sm:overflow-y-auto sm:border-r sm:border-b-0"
            >
              <span className="hidden px-2.5 pb-1 text-[11px] text-muted-foreground sm:block">
                Language
              </span>
              {languages.map((code) => (
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
            </div>
            <div className="min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto p-3">
              <p className="pb-1 text-xs text-muted-foreground">
                Models for {language ? languageLabel(language) : "this environment"}
              </p>
              {visibleModels.map((model) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  busy={operation !== null}
                  onDownload={() =>
                    runModelOperation(model.id, async () => {
                      const result = await runtime.runPromise(
                        downloadEnvironmentSpeechModel(prepared, model.id),
                      );
                      if (
                        result.models.some(
                          (candidate) =>
                            candidate.id === model.id && candidate.state === "installed",
                        )
                      ) {
                        await runtime.runPromise(selectEnvironmentSpeechModel(prepared, model.id));
                      }
                    })
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
              {currentModels.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  No transcription models are available.
                </p>
              ) : null}
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
          description="Help transcription recognize names, technical terms, and uncommon vocabulary."
          control={
            <div className="w-full max-w-80 space-y-2">
              <div className="flex items-center gap-1.5">
                <Input
                  value={customWordDraft}
                  maxLength={50}
                  placeholder="Add a word or phrase"
                  disabled={!currentStatus?.supported || operation !== null}
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
                    !normalizedCustomWord ||
                    normalizedCustomWord.length > 50 ||
                    customWords.includes(normalizedCustomWord) ||
                    customWords.length >= 100 ||
                    operation !== null
                  }
                  onClick={addCustomWord}
                >
                  Add
                </Button>
              </div>
              {customWords.length > 0 ? (
                <div className="flex flex-wrap justify-end gap-1">
                  {customWords.map((word) => (
                    <Button
                      key={word}
                      type="button"
                      size="xs"
                      variant="secondary"
                      disabled={operation !== null}
                      aria-label={`Remove ${word}`}
                      onClick={() => updateCustomWords(customWords.filter((item) => item !== word))}
                    >
                      {word}
                      <XIcon className="ml-1 size-3" />
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("remove-filler-words")}
          description="Remove common hesitation words while preserving ambiguous words in multilingual transcription."
          control={
            <Switch
              aria-label="Remove filler words"
              checked={removeFillerWords}
              disabled={!currentStatus?.supported || operation !== null}
              onCheckedChange={(enabled) => {
                if (!prepared) return;
                setOperation("filler-words");
                void runtime
                  .runPromise(updateEnvironmentSpeechFillerWordRemoval(prepared, enabled))
                  .then((value) => setStatus({ prepared, value }))
                  .catch((error) => {
                    toastManager.add({
                      type: "error",
                      title: "Could not update filler word removal",
                      description: error instanceof Error ? error.message : String(error),
                    });
                  })
                  .finally(() => setOperation(null));
              }}
            />
          }
        />
      </SettingsSection>
      <VoicePostProcessingSettings />
      <SettingsSection title="Advanced">
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
                  .then((nextStatus) => setStatus({ prepared, value: nextStatus }))
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
