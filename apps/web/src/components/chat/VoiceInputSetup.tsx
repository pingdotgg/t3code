import type { EnvironmentSpeechModel, EnvironmentSpeechStatus } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BookOpenIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Dialog, DialogClose } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";

export function VoiceInputSetup(props: {
  open: boolean;
  step: number;
  status: EnvironmentSpeechStatus | null;
  model: EnvironmentSpeechModel | null;
  downloading: boolean;
  error: string | null;
  onOpenChange(open: boolean): void;
  onDownload(): void;
  onCancelDownload(): void;
  onStartRecording(): void;
}) {
  const navigate = useNavigate();
  const selectedMicrophone = useClientSettings((settings) => settings.voiceMicrophone);
  const updateClientSettings = useUpdateClientSettings();
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [loadingMicrophones, setLoadingMicrophones] = useState(false);
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const refreshMicrophones = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    setLoadingMicrophones(true);
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicrophones(devices.filter((device) => device.kind === "audioinput"));
      setMicrophoneError(null);
    } catch {
      setMicrophoneError("Could not list microphones. You can still use the system default.");
    } finally {
      setLoadingMicrophones(false);
    }
  }, []);
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
      "Selected microphone (Unavailable)")
    : "System default";
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
          title="Set up voice input"
          description="Transcribe speech on your selected T3 environment and add the text to your draft."
        >
          <WizardSteps steps={["Model", "Make it yours"]} currentStep={props.step} />
        </WizardHeader>
        <WizardPanel>
          {props.step === 0 ? (
            <section className="space-y-3 text-sm">
              <div className="rounded-lg border border-border/70 bg-card/60 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium">{status?.model ?? "English transcription model"}</h3>
                  {status?.modelId === "handy-computer/parakeet-unified-en-0.6b-gguf" ? (
                    <span className="text-xs font-medium text-primary">
                      Recommended for English
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-muted-foreground">
                  Download {status ? Math.round(status.size / 1024 / 1024) : 697} MB to your
                  selected T3 environment. Microphone audio is sent to that environment for
                  transcription, including when it is remote.
                </p>
              </div>
              {props.downloading ? (
                <div role="status" className="space-y-1 text-muted-foreground">
                  <div
                    role="progressbar"
                    aria-label="Speech model download progress"
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
                      ? "Verifying download…"
                      : progress === null
                        ? "Starting download…"
                        : `${progress}% downloaded`}
                  </p>
                </div>
              ) : null}
              {props.error ? (
                <p role="alert" className="text-destructive">
                  {props.error}
                </p>
              ) : null}
              <Button variant="link" size="sm" onClick={() => openSettings("local-voice-input")}>
                Choose another model or language in Voice settings
              </Button>
            </section>
          ) : (
            <section className="space-y-4 text-sm">
              <div className="space-y-2">
                <label className="font-medium" htmlFor="voice-setup-microphone">
                  Microphone
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
                      aria-label="Microphone"
                      className="min-w-0 flex-1"
                    >
                      <SelectValue>{selectedMicrophoneLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="system-default">System default</SelectItem>
                      {selectedIsUnavailable ? (
                        <SelectItem value={`device:${selectedMicrophone}`}>
                          Selected microphone (Unavailable)
                        </SelectItem>
                      ) : null}
                      {microphones.map((device, index) => (
                        <SelectItem key={device.deviceId} value={`device:${device.deviceId}`}>
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
                {selectedIsUnavailable ? (
                  <p className="text-xs text-destructive">
                    The selected microphone is unavailable. Choose another or use the system
                    default.
                  </p>
                ) : null}
                {microphoneError ? (
                  <p role="alert" className="text-xs text-muted-foreground">
                    {microphoneError}
                  </p>
                ) : null}
              </div>
              <p className="text-muted-foreground">
                Voice input is ready. You can personalize it now or start recording and come back
                later.
              </p>
              <div className="space-y-3">
                <p className="flex gap-3">
                  <BookOpenIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>
                    <strong>Dictionary</strong> helps recognize names and technical terms.
                  </span>
                </p>
                <p className="flex gap-3">
                  <SparklesIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>
                    <strong>Post-processing</strong> can polish the finished transcript.
                  </span>
                </p>
              </div>
              <Button variant="link" size="sm" onClick={() => openSettings("dictionary")}>
                Explore these features in Voice settings
              </Button>
            </section>
          )}
        </WizardPanel>
        <WizardFooter>
          {props.step === 0 ? (
            <>
              {props.downloading ? (
                <Button variant="outline" onClick={props.onCancelDownload}>
                  Cancel download
                </Button>
              ) : (
                <DialogClose render={<Button variant="outline" />}>Not now</DialogClose>
              )}
              <Button disabled={props.downloading || !status} onClick={props.onDownload}>
                {props.downloading
                  ? "Downloading…"
                  : props.error
                    ? "Retry download"
                    : "Download model"}
              </Button>
            </>
          ) : (
            <Button onClick={props.onStartRecording}>Start recording</Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
