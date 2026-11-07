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

import { useT } from "../../hooks/useI18n";
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
  const t = useT();
  const environment = useEnvironment(props.environmentId);
  const canManage = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const selectedMicrophone = useClientSettings((settings) => settings.voiceMicrophone);
  const [microphones, setMicrophones] = useState<BrowserMicrophone[]>([]);
  const [loadingMicrophones, setLoadingMicrophones] = useState(false);
  const [microphoneError, setMicrophoneError] = useState(false);
  const refreshMicrophones = useStableCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    setLoadingMicrophones(true);
    try {
      setMicrophones(await listBrowserMicrophones());
      setMicrophoneError(false);
    } catch {
      setMicrophoneError(true);
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
      t("voice.chat.setup.microphoneUnavailableOption"))
    : t("voice.chat.setup.systemDefault");
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
          title={t("voice.chat.setup.title")}
          description={t("voice.chat.setup.description", {
            environment: environment?.label ?? t("voice.chat.setup.environmentFallback"),
          })}
        >
          <WizardSteps
            steps={[t("voice.chat.setup.stepModel"), t("voice.chat.setup.stepReady")]}
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
                        {t("voice.chat.setup.recommended", {
                          language: languageLabel(props.language),
                        })}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    {t("voice.chat.setup.downloadInfo", {
                      size: Math.round(model.size / 1024 / 1024),
                      environment: environment?.label ?? t("voice.chat.setup.environmentFallback"),
                    })}
                  </p>
                  <p className="mt-2 text-muted-foreground">{t("voice.chat.setup.sileroInfo")}</p>
                  {props.downloading ? (
                    <div role="status" className="mt-4 space-y-1 text-muted-foreground">
                      <div
                        role="progressbar"
                        aria-label={t("voice.chat.setup.downloadProgress")}
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
                          ? t("voice.chat.setup.verifying")
                          : progress === null
                            ? t("voice.chat.setup.starting")
                            : t("voice.chat.setup.downloaded", { percent: progress })}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : !props.error ? (
                <p role="status" className="text-muted-foreground">
                  {t("voice.chat.setup.loadingModels")}
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
                  {t("voice.chat.setup.microphone")}
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
                      aria-label={t("voice.chat.setup.microphone")}
                      className="min-w-0 flex-1"
                    >
                      <SelectValue>{selectedMicrophoneLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="system-default">
                        {t("voice.chat.setup.systemDefault")}
                      </SelectItem>
                      {selectedIsUnavailable ? (
                        <SelectItem value={`device:${selectedMicrophone}`}>
                          {t("voice.chat.setup.microphoneUnavailableOption")}
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
                    aria-label={t("voice.chat.setup.refreshMicrophones")}
                    onClick={() => void refreshMicrophones()}
                  >
                    <RefreshCwIcon className="size-3.5" />
                  </Button>
                </div>
                {selectedIsUnavailable ? (
                  <p className="text-xs text-destructive">
                    {t("voice.chat.setup.microphoneUnavailable")}
                  </p>
                ) : null}
                {microphoneError ? (
                  <p role="alert" className="text-xs text-muted-foreground">
                    {t("voice.chat.setup.microphoneListFailed")}
                  </p>
                ) : null}
              </div>
              <p className="text-muted-foreground">{t("voice.chat.setup.dictationHint")}</p>
            </section>
          )}
        </WizardPanel>
        <WizardFooter>
          {props.step === 0 ? (
            <>
              <Button variant="outline" onClick={() => openSettings("speech-models")}>
                {model ? t("voice.chat.setup.chooseModel") : t("voice.chat.setup.chooseModelFirst")}
              </Button>
              {props.onRetryCatalog ? (
                <Button onClick={props.onRetryCatalog}>{t("voice.chat.setup.retryCatalog")}</Button>
              ) : null}
              {props.downloading ? (
                <Button variant="outline" disabled={!canManage} onClick={props.onCancelDownload}>
                  {t("voice.chat.setup.cancelDownload")}
                </Button>
              ) : null}
              {model ? (
                <Button
                  disabled={!canManage || props.downloading || !status}
                  onClick={props.onDownload}
                >
                  {props.downloading
                    ? t("voice.chat.setup.downloading")
                    : props.error
                      ? t("voice.chat.setup.retryDownload")
                      : canManage
                        ? t("voice.chat.setup.downloadModel")
                        : t("voice.chat.setup.askAdmin")}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => openSettings("")}>
                {t("voice.chat.setup.customize")}
              </Button>
              <Button onClick={props.onStartRecording}>
                {t("voice.chat.setup.startDictating")}
              </Button>
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
