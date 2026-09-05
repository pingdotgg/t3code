import {
  getEnvironmentSpeechStatus,
  removeEnvironmentSpeechModel,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentSpeechStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { runtime } from "../../lib/runtime";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const SYSTEM_DEFAULT = "system-default";
const deviceValue = (id: string) => `device:${id}`;

export function VoiceSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const selectedMicrophone = useClientSettings((settings) => settings.voiceMicrophone);
  const updateClientSettings = useUpdateClientSettings();
  const [status, setStatus] = useState<EnvironmentSpeechStatus | null>(null);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [loadingMicrophones, setLoadingMicrophones] = useState(false);
  const [removingModel, setRemovingModel] = useState(false);

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

  const refreshStatus = useCallback(async () => {
    if (!prepared) return;
    try {
      setStatus(await runtime.runPromise(getEnvironmentSpeechStatus(prepared)));
    } catch {
      setStatus(null);
    }
  }, [prepared]);

  useEffect(() => {
    void refreshMicrophones();
    void refreshStatus();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) return;
    const handleDeviceChange = () => void refreshMicrophones();
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [refreshMicrophones, refreshStatus]);

  const selectedIsUnavailable = Boolean(
    selectedMicrophone && !microphones.some((device) => device.deviceId === selectedMicrophone),
  );
  const currentStatus = prepared ? status : null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice">
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
                  if (!value) return;
                  updateClientSettings({
                    voiceMicrophone: value === SYSTEM_DEFAULT ? "" : value.slice("device:".length),
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
        <SettingsRow
          {...searchableSetting("local-voice-input")}
          description={
            currentStatus?.supported
              ? currentStatus.state === "missing-model"
                ? "Downloads a 48 MiB English model on first use. Recordings are sent to this T3 environment and deleted after transcription."
                : `${currentStatus.model} is installed on this T3 environment.`
              : (currentStatus?.reason ?? "Connect to a current T3 environment to use voice input.")
          }
          control={
            currentStatus?.supported && currentStatus.state !== "missing-model" ? (
              <Button
                variant="destructive-outline"
                size="sm"
                disabled={removingModel || currentStatus.state === "transcribing"}
                onClick={() => {
                  if (!prepared) return;
                  setRemovingModel(true);
                  void runtime
                    .runPromise(removeEnvironmentSpeechModel(prepared))
                    .then(setStatus)
                    .catch((error) =>
                      toastManager.add({
                        type: "error",
                        title: "Could not remove speech model",
                        description: error instanceof Error ? error.message : String(error),
                      }),
                    )
                    .finally(() => setRemovingModel(false));
                }}
              >
                Remove model
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">
                {currentStatus?.supported ? "Download on first use" : "Unavailable"}
              </span>
            )
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
