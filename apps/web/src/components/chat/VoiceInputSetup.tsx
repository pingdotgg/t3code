import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
import { useStableCallback } from "~/hooks/useStableCallback";
import { listBrowserMicrophones, type BrowserMicrophone } from "../../speech/browserMicrophones";
import type {
  EnvironmentId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { useEnvironment } from "../../state/environments";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentScope } from "../../state/session";
import { languageLabel } from "../settings/SpeechLanguageSelect";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";

export function VoiceInputSetup(props: {
  environmentId: EnvironmentId | null;
  open: boolean;
  step: number;
  status: EnvironmentSpeechStatus | null;
  model: EnvironmentSpeechModel | null;
  /** The language the offered model was chosen for. */
  language: string | null;
  downloading: boolean;
  error: string | null;
  onOpenChange(open: boolean): void;
  onRetryCatalog: (() => void) | null;
  onDownload(): void;
  onCancelDownload(): void;
  onStartRecording(): void;
}) {
  const navigate = useNavigate();
  const environment = useEnvironment(props.environmentId);
  const canManage = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const selectedMicrophone = useClientSettings((settings) => settings.voiceMicrophone);
  const [microphones, setMicrophones] = useState<BrowserMicrophone[]>([]);
  const [loadingMicrophones, setLoadingMicrophones] = useState(false);
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const refreshMicrophones = useStableCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    setLoadingMicrophones(true);
    try {
      setMicrophones(await listBrowserMicrophones());
      setMicrophoneError(null);
    } catch {
      setMicrophoneError(
        t({ message: "Could not list microphones. You can still use the system default." }),
      );
    }
    setLoadingMicrophones(false);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to native microphone changes while the device setup step is visible
  useEffect(() => {
    if (!props.open || props.step !== 1) return;
    queueMicrotask(() => void refreshMicrophones());
    const mediaDevices = navigator.mediaDevices;
    mediaDevices?.addEventListener?.("devicechange", refreshMicrophones);
    return () => mediaDevices?.removeEventListener?.("devicechange", refreshMicrophones);
  }, [props.open, props.step, refreshMicrophones]);
  const selectedIsUnavailable = Boolean(
    selectedMicrophone && !microphones.some((device) => device.deviceId === selectedMicrophone),
  );
  const selectedMicrophoneLabel = selectedMicrophone
    ? (microphones.find((device) => device.deviceId === selectedMicrophone)?.label ??
      t({ message: "Selected microphone (Unavailable)" }))
    : t({ message: "System default" });
  const transcriptionEnvironment =
    environment?.label ?? t({ message: "your transcription environment" });
  const recommendedLanguage = props.language ? languageLabel(props.language) : "";
  const status = props.status?.supported ? props.status : null;
  const model = props.model;
  const modelSizeMb = model ? Math.round(model.size / 1024 / 1024) : 0;
  const progress =
    model?.downloaded === undefined ? null : Math.round((model.downloaded / model.size) * 100);
  const openSettings = (hash: string) => {
    props.onOpenChange(false);
    void navigate({ to: "/settings/voice", hash });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <WizardPopup>
        <WizardHeader
          title={t({ message: "Set up voice input" })}
          description={t`Transcribe speech on ${transcriptionEnvironment} and use voice input across environments.`}
        >
          <WizardSteps
            steps={[t({ message: "Model" }), t({ message: "Ready to dictate" })]}
            currentStep={props.step}
          />
        </WizardHeader>
        <WizardPanel>
          {props.step === 0 ? (
            <section className="space-y-3 text-sm">
              {model ? (
                <div className="rounded-lg border border-border/70 bg-card/60 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-medium">{model.name}</h3>
                    {model?.recommended && props.language ? (
                      <span className="text-xs font-medium text-primary">
                        <Trans>Recommended for {recommendedLanguage}</Trans>
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    <Trans>
                      Download the {modelSizeMb} MB model to {transcriptionEnvironment}. Microphone
                      audio is sent there for transcription, as chosen in Voice settings.
                    </Trans>
                  </p>
                  <p className="mt-2 text-muted-foreground">
                    <Trans>
                      Silero (1.2 MB), used for silence filtering and pause detection, downloads
                      alongside the speech model. An installed copy is reused.
                    </Trans>
                  </p>
                  {props.downloading ? (
                    <div role="status" className="mt-4 space-y-1 text-muted-foreground">
                      <div
                        role="progressbar"
                        aria-label={t({ message: "Speech model download progress" })}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progress ?? undefined}
                        className="h-1 overflow-hidden rounded-full bg-muted"
                      >
                        <div
                          className="h-full bg-primary transition-[width] duration-200"
                          style={{ width: `${progress ?? 0}%` }}
                        />
                      </div>
                      <p className="text-xs">
                        {model?.state === "verifying" ? (
                          <Trans>Verifying download…</Trans>
                        ) : progress === null ? (
                          <Trans>Starting download…</Trans>
                        ) : (
                          <Trans>{progress}% downloaded</Trans>
                        )}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : !props.error ? (
                <p role="status" className="text-muted-foreground">
                  <Trans>Loading transcription models…</Trans>
                </p>
              ) : null}
              {props.error ? (
                <p role="alert" className="text-destructive">
                  {props.error}
                </p>
              ) : null}
            </section>
          ) : (
            <section className="space-y-4 text-sm">
              <div className="space-y-2">
                <label className="font-medium" htmlFor="voice-setup-microphone">
                  <Trans>Microphone</Trans>
                </label>
                <div className="flex items-center gap-2">
                  <Select
                    value={selectedMicrophone ? `device:${selectedMicrophone}` : "system-default"}
                    disabled={loadingMicrophones}
                    onValueChange={(value) => {
                      if (value)
                        void updateClientSettings({
                          voiceMicrophone:
                            value === "system-default" ? "" : value.slice("device:".length),
                        });
                    }}
                  >
                    <SelectTrigger
                      id="voice-setup-microphone"
                      size="sm"
                      aria-label={t({ message: "Microphone" })}
                      className="min-w-0 flex-1"
                    >
                      <SelectValue>{selectedMicrophoneLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="system-default">
                        <Trans>System default</Trans>
                      </SelectItem>
                      {selectedIsUnavailable ? (
                        <SelectItem value={`device:${selectedMicrophone}`}>
                          <Trans>Selected microphone (Unavailable)</Trans>
                        </SelectItem>
                      ) : null}
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
                    disabled={loadingMicrophones}
                    aria-label={t({ message: "Refresh microphones" })}
                    onClick={() => void refreshMicrophones()}
                  >
                    <RefreshCwIcon className="size-3.5" />
                  </Button>
                </div>
                {selectedIsUnavailable ? (
                  <p className="text-xs text-destructive">
                    <Trans>
                      The selected microphone is unavailable. Choose another or use the system
                      default.
                    </Trans>
                  </p>
                ) : null}
                {microphoneError ? (
                  <p role="alert" className="text-xs text-muted-foreground">
                    {microphoneError}
                  </p>
                ) : null}
              </div>
              <p className="text-muted-foreground">
                <Trans>
                  Speak and transcribe in multiple languages or translate into English, and get
                  names and technical terms right with the dictionary in Voice settings.
                </Trans>
              </p>
            </section>
          )}
        </WizardPanel>
        <WizardFooter>
          {props.step === 0 ? (
            <>
              <Button variant="outline" onClick={() => openSettings("speech-models")}>
                {model ? (
                  <Trans>Choose another model or language</Trans>
                ) : (
                  <Trans>Choose a model or language</Trans>
                )}
              </Button>
              {props.onRetryCatalog ? (
                <Button onClick={props.onRetryCatalog}>
                  <Trans>Retry loading models</Trans>
                </Button>
              ) : null}
              {props.downloading ? (
                <Button variant="outline" disabled={!canManage} onClick={props.onCancelDownload}>
                  <Trans>Cancel download</Trans>
                </Button>
              ) : null}
              {model ? (
                <Button
                  disabled={!canManage || props.downloading || !status}
                  onClick={props.onDownload}
                >
                  {props.downloading ? (
                    <Trans>Downloading…</Trans>
                  ) : props.error ? (
                    <Trans>Try again</Trans>
                  ) : canManage ? (
                    <Trans>Download model</Trans>
                  ) : (
                    <Trans>Ask an environment admin to download</Trans>
                  )}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => openSettings("")}>
                <Trans>Customize in Voice settings</Trans>
              </Button>
              <Button onClick={props.onStartRecording}>
                <Trans>Start dictating</Trans>
              </Button>
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
