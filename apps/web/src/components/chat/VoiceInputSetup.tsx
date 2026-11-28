import { T, Var, msg, useGT, useLocale } from "gt-react";
import { m } from "~/i18n/messages";
import {
  labelBrowserMicrophones,
  updateMicrophoneOrder,
  useMicrophoneRefresh,
  type BrowserMicrophone,
} from "../../speech/browserMicrophones";
import type {
  EnvironmentId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, MicIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import {
  isSystemDefaultDeviceId,
  microphoneOrder,
  preferMicrophone,
  preferredMicrophoneId,
} from "../../speech/microphoneOrder";
import { useEnvironment } from "../../state/environments";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { speechModelDownloadPercent } from "@t3tools/shared/speech";
import { useEnvironmentScope } from "../../state/session";
import { languageLabel } from "../settings/SpeechLanguageSelect";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";

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
  const gt = useGT();
  const locale = useLocale();
  const navigate = useNavigate();
  const environment = useEnvironment(props.environmentId);
  const languageName = props.language ? languageLabel(props.language, locale) : null;
  const canManage = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const order = useClientSettings(microphoneOrder);
  const [microphones, setMicrophones] = useState<BrowserMicrophone[]>([]);
  const selectedMicrophone = preferredMicrophoneId(order, microphones);
  const [loadingMicrophones, setLoadingMicrophones] = useState(false);
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const refreshMicrophones = useMicrophoneRefresh({
    enabled: props.open && props.step === 1,
    onStart: () => setLoadingMicrophones(true),
    onResult: (devices) => {
      if (devices) setMicrophones(labelBrowserMicrophones(devices));
      setMicrophoneError(
        devices ? null : m(msg("Couldn’t list microphones. The system default still works.")),
      );
      setLoadingMicrophones(false);
    },
  });
  const selectedIsUnavailable = Boolean(
    selectedMicrophone && !microphones.some((device) => device.deviceId === selectedMicrophone),
  );
  const selectedMicrophoneLabel = selectedMicrophone
    ? (microphones.find((device) => device.deviceId === selectedMicrophone)?.label ??
      gt("Selected microphone (Unavailable)"))
    : gt("System default");
  const status = props.status?.supported ? props.status : null;
  const model = props.model;
  const progress =
    model?.downloaded === undefined
      ? null
      : speechModelDownloadPercent(model.downloaded, model.size);
  const openSettings = (hash: string) => {
    props.onOpenChange(false);
    void navigate({ to: "/settings/voice", hash });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <WizardPopup>
        <WizardHeader
          title={props.step === 0 ? gt("Set up voice input") : gt("Voice input is ready")}
          description={
            props.step === 0
              ? environment?.label != null
                ? gt("Download a speech model once. Your audio is transcribed on {destination}.", {
                    destination: environment.label,
                  })
                : gt(
                    "Download a speech model once. Your audio is transcribed on your transcription environment.",
                  )
              : gt("Pick a microphone, then start talking.")
          }
        />
        <WizardPanel>
          {props.step === 0 ? (
            <section className="space-y-3 text-sm">
              {model ? (
                <div className="space-y-3 rounded-lg border border-border/70 bg-card/60 p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="min-w-0 truncate font-medium">{model.name}</h3>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {gt("{size} MB", { size: Math.round(model.size / 1024 / 1024) })}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {model.recommended && props.language ? (
                      <T>
                        Recommended for <Var>{languageName}</Var>. Includes a 1.2 MB silence
                        detector.
                      </T>
                    ) : (
                      <T>Includes a 1.2 MB silence detector.</T>
                    )}
                  </p>
                  {props.downloading ? (
                    <div role="status" className="space-y-1.5">
                      <div
                        role="progressbar"
                        aria-label={gt("Speech model download progress")}
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
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {model.state === "verifying"
                          ? gt("Verifying…")
                          : progress === null
                            ? gt("Starting download…")
                            : gt("{progress}% downloaded", { progress })}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : !props.error ? (
                <p role="status" className="text-muted-foreground">
                  <T>Loading transcription models…</T>
                </p>
              ) : null}
              {props.error ? (
                <p role="alert" className="flex items-start gap-1.5 text-destructive">
                  <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {props.error}
                </p>
              ) : null}
            </section>
          ) : (
            <section className="space-y-2 text-sm">
              <label className="sr-only" htmlFor="voice-setup-microphone">
                <T>Microphone</T>
              </label>
              <div className="flex items-center gap-2">
                <Select
                  value={selectedMicrophone ? `device:${selectedMicrophone}` : "system-default"}
                  disabled={loadingMicrophones}
                  onValueChange={(value) => {
                    if (!value) return;
                    const deviceId = value.slice("device:".length);
                    const label =
                      microphones.find((device) => device.deviceId === deviceId)?.label ?? "";
                    updateMicrophoneOrder((order) =>
                      preferMicrophone(
                        order,
                        value === "system-default" || isSystemDefaultDeviceId(deviceId)
                          ? { kind: "default" }
                          : { kind: "device", deviceId, label },
                      ),
                    );
                  }}
                >
                  <SelectTrigger
                    id="voice-setup-microphone"
                    size="sm"
                    aria-label={gt("Microphone")}
                    className="min-w-0 flex-1"
                  >
                    <MicIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <SelectValue>{selectedMicrophoneLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value="system-default">
                      <T>System default</T>
                    </SelectItem>
                    {selectedIsUnavailable ? (
                      <SelectItem value={`device:${selectedMicrophone}`}>
                        <T>Selected microphone (Unavailable)</T>
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
                  aria-label={gt("Refresh microphones")}
                  onClick={() => void refreshMicrophones()}
                >
                  <RefreshCwIcon className="size-3.5" />
                </Button>
              </div>
              {selectedIsUnavailable ? (
                <p className="text-xs text-destructive">
                  <T>That microphone is unplugged. Pick another one.</T>
                </p>
              ) : null}
              {microphoneError ? (
                <p role="alert" className="text-xs text-muted-foreground">
                  {microphoneError}
                </p>
              ) : null}
            </section>
          )}
        </WizardPanel>
        {props.step === 0 ? (
          <WizardFooter
            leading={
              <Button variant="ghost" onClick={() => openSettings("speech-models")}>
                {model ? gt("Other models") : gt("Choose a model")}
              </Button>
            }
          >
            {props.onRetryCatalog ? (
              <Button onClick={props.onRetryCatalog}>
                <T>Retry loading models</T>
              </Button>
            ) : null}
            {props.downloading ? (
              <Button variant="outline" disabled={!canManage} onClick={props.onCancelDownload}>
                <T>Cancel download</T>
              </Button>
            ) : null}
            {model ? (
              <Button
                disabled={!canManage || props.downloading || !status}
                onClick={props.onDownload}
              >
                {props.downloading
                  ? gt("Downloading…")
                  : props.error
                    ? gt("Try again")
                    : canManage
                      ? gt("Download model")
                      : gt("Needs an admin to download")}
              </Button>
            ) : null}
          </WizardFooter>
        ) : (
          <WizardFooter
            leading={
              <Button variant="ghost" onClick={() => openSettings("")}>
                <T>Voice settings</T>
              </Button>
            }
          >
            <Button onClick={props.onStartRecording}>
              <MicIcon />
              <T>Start dictating</T>
            </Button>
          </WizardFooter>
        )}
      </WizardPopup>
    </Dialog>
  );
}
