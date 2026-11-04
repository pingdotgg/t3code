import { useEffect, useState } from "react";
import { DEFAULT_READ_ALOUD_VOICE } from "@t3tools/contracts/settings";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";
import { startReadAloud, stopReadAloud, useReadAloudState } from "~/readAloud/readAloudPlayer";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

interface Voice {
  readonly shortName: string;
  readonly gender: string;
  readonly personalities: string;
}

const SAMPLE_ID = "settings:read-aloud-sample";
const SAMPLE_TEXT = "Here's how replies will sound when you press the speaker button.";

export function voiceLabel(shortName: string): string {
  const match = /^([a-z]{2,3})-([A-Za-z]+)-(.+?)(Multilingual)?Neural$/.exec(shortName);
  if (!match) return shortName;
  const [, , region, name, multilingual] = match;
  const spaced = name!.replace(/-/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return `${spaced}${multilingual ? " (Multilingual)" : ""} · ${region}`;
}

function sortVoices(voices: ReadonlyArray<Voice>): Voice[] {
  return voices
    .filter((voice) => voice.shortName.startsWith("en-"))
    .toSorted((a, b) => {
      const aUs = a.shortName.startsWith("en-US-") ? 0 : 1;
      const bUs = b.shortName.startsWith("en-US-") ? 0 : 1;
      return aUs - bUs || a.shortName.localeCompare(b.shortName);
    });
}

export function ReadAloudSetting() {
  const voice = useClientSettings((settings) => settings.readAloudVoice);
  const hydrated = useClientSettingsHydrated();
  const updateSettings = useUpdatePrimarySettings();
  const readAloud = useReadAloudState();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.readAloud;
  const [voices, setVoices] = useState<Voice[] | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the desktop app's edge-tts process for its voice list once while the settings page is open.
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.listVoices().then((list) => {
      if (!cancelled) setVoices(sortVoices(list));
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge) return null;
  const options =
    voices && voices.some((option) => option.shortName === voice)
      ? voices
      : [{ shortName: voice, gender: "", personalities: "" }, ...(voices ?? [])];
  const sampling = readAloud.messageId === SAMPLE_ID && readAloud.status !== "idle";

  return (
    <SettingsSection id="read-aloud" title="Read aloud">
      <SettingsRow
        {...searchableSetting("read-aloud-voice")}
        title="Voice"
        description="The voice for the speaker button on replies. Uses Microsoft Edge's natural voices through edge-tts, which sends the reply text to Microsoft."
        control={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                if (sampling) stopReadAloud();
                else void startReadAloud({ messageId: SAMPLE_ID, markdown: SAMPLE_TEXT, voice });
              }}
            >
              {sampling ? "Stop" : "Play sample"}
            </Button>
            <Select
              value={voice}
              disabled={!hydrated}
              onValueChange={(value) => {
                if (typeof value === "string" && value.length > 0) {
                  updateSettings({ readAloudVoice: value });
                }
              }}
            >
              <SelectTrigger className="w-60" aria-label="Read-aloud voice">
                <SelectValue>{voiceLabel(voice)}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {options.map((option) => (
                  <SelectItem key={option.shortName} value={option.shortName}>
                    {voiceLabel(option.shortName)}
                    {option.personalities ? (
                      <span className="ml-2 text-muted-foreground">{option.personalities}</span>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <SettingResetButton
              label="read-aloud voice"
              disabled={!hydrated || voice === DEFAULT_READ_ALOUD_VOICE}
              onClick={() => updateSettings({ readAloudVoice: DEFAULT_READ_ALOUD_VOICE })}
            />
          </div>
        }
      >
        {voices !== null && voices.length === 0 && (
          <p role="alert" className="pb-2 text-sm text-destructive">
            Couldn't list voices. Install edge-tts with: uv tool install edge-tts
          </p>
        )}
        {readAloud.fallbackReason && (
          <p role="status" className="pb-2 text-sm text-muted-foreground">
            {readAloud.fallbackReason} The basic Windows voice was used instead.
          </p>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
