import type { DesktopMicrophoneSettings, DesktopSpeechStatus } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const SYSTEM_DEFAULT = "__system_default__";

export function VoiceSettingsPanel() {
  const speech = window.desktopBridge?.speech;
  const [status, setStatus] = useState<DesktopSpeechStatus | null>(null);
  const [microphones, setMicrophones] = useState<DesktopMicrophoneSettings | null>(null);
  const [loadingMicrophones, setLoadingMicrophones] = useState(false);

  const refreshMicrophones = useCallback(async () => {
    if (!speech) return;
    setLoadingMicrophones(true);
    try {
      setMicrophones(await speech.getMicrophones());
    } finally {
      setLoadingMicrophones(false);
    }
  }, [speech]);

  useEffect(() => {
    if (!speech) return;
    void speech.getStatus().then(setStatus);
    void refreshMicrophones();
    return speech.onEvent((event) => {
      if (event.type === "status") setStatus(event.status);
    });
  }, [refreshMicrophones, speech]);

  if (!speech) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Voice">
          <p className="px-1 text-sm text-muted-foreground">
            Local voice input settings are available in the desktop app.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const selected = microphones?.selected ?? "";
  const selectedIsUnavailable = Boolean(selected && !microphones?.devices.includes(selected));

  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice">
        <SettingsRow
          {...searchableSetting("microphone")}
          description={
            selectedIsUnavailable
              ? "The selected microphone is disconnected. Voice input will use the system default until it returns."
              : "Choose the microphone used for local voice input."
          }
          control={
            <div className="flex w-full max-w-80 items-center gap-1.5">
              <Select
                value={selected || SYSTEM_DEFAULT}
                disabled={!microphones || loadingMicrophones}
                onValueChange={(value) => {
                  if (!value) return;
                  void speech
                    .setMicrophone(value === SYSTEM_DEFAULT ? "" : value)
                    .then(setMicrophones);
                }}
              >
                <SelectTrigger size="sm" aria-label="Microphone" className="min-w-0 flex-1">
                  <SelectValue
                    placeholder={loadingMicrophones ? "Finding microphones…" : "Microphone"}
                  />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={SYSTEM_DEFAULT}>System default</SelectItem>
                  {selectedIsUnavailable ? (
                    <SelectItem value={selected}>{selected} (Unavailable)</SelectItem>
                  ) : null}
                  {microphones?.devices.map((device) => (
                    <SelectItem key={device} value={device}>
                      {device}
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
        {status?.supported ? (
          <SettingsRow
            {...searchableSetting("local-voice-input")}
            description={
              status.state === "missing-model"
                ? "Downloads a 48 MiB English model on first use. Audio stays on this device."
                : "Moonshine Streaming Tiny is stored locally. Microphone audio is not saved."
            }
            control={
              status.state === "missing-model" ? (
                <span className="text-xs text-muted-foreground">Download on first use</span>
              ) : (
                <Button
                  variant="destructive-outline"
                  size="sm"
                  disabled={
                    status.state === "recording" ||
                    status.state === "transcribing" ||
                    status.state === "downloading"
                  }
                  onClick={() => void speech.removeModel().then(setStatus)}
                >
                  Remove model
                </Button>
              )
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
