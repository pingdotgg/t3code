import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  removeEnvironmentSpeechModel,
  selectEnvironmentSpeechModel,
} from "@t3tools/client-runtime/voice-input";
import type {
  EnvironmentId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { CheckIcon, DownloadIcon, GlobeIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const SYSTEM_DEFAULT = "system-default";
const PRIMARY_ENVIRONMENT = "primary-environment";
const deviceValue = (id: string) => `device:${id}`;
const environmentValue = (id: EnvironmentId) => `environment:${id}`;
const formatSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

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
      className={`rounded-lg border px-3.5 py-3 ${model.active ? "border-accent/50 bg-accent/5" : "border-border/70 bg-card/30"}`}
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
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{model.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <GlobeIcon className="size-3" />
              {model.languages.length === 1 ? "English" : `${model.languages.length} languages`}
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

  const refreshModels = useCallback(async () => {
    if (!prepared) return;
    const [nextStatus, nextModels] = await Promise.all([
      runtime.runPromise(getEnvironmentSpeechStatus(prepared)),
      runtime.runPromise(getEnvironmentSpeechModels(prepared)),
    ]);
    setStatus({ prepared, value: nextStatus });
    setModels(nextModels.models);
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

  const runModelOperation = (modelId: string, run: () => Promise<unknown>) => {
    setOperation(modelId);
    void run()
      .then(refreshModels)
      .catch((error) =>
        toastManager.add({
          type: "error",
          title: "Could not update transcription model",
          description: error instanceof Error ? error.message : String(error),
        }),
      )
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
  const currentStatus = status?.prepared === prepared ? status.value : null;
  const installed = models.filter((model) => model.state !== "downloadable");
  const available = models.filter((model) => model.state === "downloadable");

  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice">
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
                <SelectValue />
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
                  />
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
      <SettingsSection
        title="Transcription Models"
        id={searchableSetting("local-voice-input").id}
        variant="plain"
      >
        <div className="space-y-4 px-3 sm:px-4">
          <p className="max-w-xl text-[12px] leading-relaxed text-muted-foreground/80">
            Models run on the selected T3 environment. Recordings are deleted after transcription.
          </p>
          {currentStatus?.supported && prepared ? (
            <div className="space-y-4">
              {installed.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Your models</h3>
                  {installed.map((model) => (
                    <ModelCard
                      key={model.id}
                      model={model}
                      busy={operation !== null}
                      onDownload={() =>
                        runModelOperation(model.id, () =>
                          runtime.runPromise(downloadEnvironmentSpeechModel(prepared, model.id)),
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
                      }
                      onDelete={() =>
                        void ensureLocalApi()
                          .dialogs.confirm(`Delete ${model.name} from this T3 environment?`)
                          .then((confirmed) => {
                            if (confirmed)
                              runModelOperation(model.id, () =>
                                runtime.runPromise(
                                  removeEnvironmentSpeechModel(prepared, model.id),
                                ),
                              );
                          })
                      }
                    />
                  ))}
                </div>
              ) : null}
              {available.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Available models</h3>
                  {available.map((model) => (
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
                            !result.models.some(
                              (candidate) =>
                                candidate.id === model.id && candidate.state === "installed",
                            )
                          )
                            return;
                          await runtime.runPromise(
                            selectEnvironmentSpeechModel(prepared, model.id),
                          );
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
                      }
                      onDelete={() => undefined}
                    />
                  ))}
                </div>
              ) : null}
              {models.length === 0 ? (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  No transcription models are available.
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
              {currentStatus && !currentStatus.supported
                ? currentStatus.reason
                : "Connect to a current T3 environment to manage transcription models."}
            </div>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
