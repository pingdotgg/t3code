import { useStableCallback } from "~/hooks/useStableCallback";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("chat");
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
      setMicrophoneError(t("voice.micListFailed"));
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
      t("voice.selectedUnavailable"))
    : t("voice.systemDefault");
  const status = props.status?.supported ? props.status : null;
  const model = props.model;
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
          title={t("voice.title")}
          description={t("voice.description", {
            env: environment?.label ?? t("voice.transcriptionEnv"),
          })}
        >
          <WizardSteps
            steps={[t("voice.stepModel"), t("voice.stepReady")]}
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
                        {t("voice.recommendedFor", { language: languageLabel(props.language) })}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    {t("voice.downloadDetail", {
                      size: Math.round(model.size / 1024 / 1024),
                      env: environment?.label ?? t("voice.transcriptionEnv"),
                    })}
                  </p>
                  <p className="mt-2 text-muted-foreground">{t("voice.sileroDetail")}</p>
                  {props.downloading ? (
                    <div role="status" className="mt-4 space-y-1 text-muted-foreground">
                      <div
                        role="progressbar"
                        aria-label={t("voice.downloadProgressAria")}
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
                        {model?.state === "verifying"
                          ? t("voice.verifying")
                          : progress === null
                            ? t("voice.startingDownload")
                            : t("voice.downloaded", { percent: progress })}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : !props.error ? (
                <p role="status" className="text-muted-foreground">
                  {t("voice.loadingModels")}
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
                  {t("voice.microphone")}
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
                      aria-label={t("voice.micAria")}
                      className="min-w-0 flex-1"
                    >
                      <SelectValue>{selectedMicrophoneLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="system-default">{t("voice.systemDefault")}</SelectItem>
                      {selectedIsUnavailable ? (
                        <SelectItem value={`device:${selectedMicrophone}`}>
                          Selected microphone (Unavailable)
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
                    aria-label={t("voice.refreshMics")}
                    onClick={() => void refreshMicrophones()}
                  >
                    <RefreshCwIcon className="size-3.5" />
                  </Button>
                </div>
                {selectedIsUnavailable ? (
                  <p className="text-xs text-destructive">{t("voice.microphoneUnavailable")}</p>
                ) : null}
                {microphoneError ? (
                  <p role="alert" className="text-xs text-muted-foreground">
                    {microphoneError}
                  </p>
                ) : null}
              </div>
              <p className="text-muted-foreground">{t("voice.multilingualHint")}</p>
            </section>
          )}
        </WizardPanel>
        <WizardFooter>
          {props.step === 0 ? (
            <>
              <Button variant="outline" onClick={() => openSettings("speech-models")}>
                {model ? t("voice.chooseAnotherModel") : t("voice.chooseModel")}
              </Button>
              {props.onRetryCatalog ? (
                <Button onClick={props.onRetryCatalog}>{t("voice.retryLoadingModels")}</Button>
              ) : null}
              {props.downloading ? (
                <Button variant="outline" disabled={!canManage} onClick={props.onCancelDownload}>
                  {t("voice.cancelDownload")}
                </Button>
              ) : null}
              {model ? (
                <Button
                  disabled={!canManage || props.downloading || !status}
                  onClick={props.onDownload}
                >
                  {props.downloading
                    ? t("voice.downloading")
                    : props.error
                      ? t("voice.tryAgain")
                      : canManage
                        ? t("voice.downloadModel")
                        : t("voice.askAdmin")}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => openSettings("")}>
                {t("voice.customize")}
              </Button>
              <Button onClick={props.onStartRecording}>{t("voice.startDictating")}</Button>
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
