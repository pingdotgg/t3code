import type { SpeechSettings } from "@t3tools/contracts";
import { PlayIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";

import { useAtomValue } from "@effect/atom-react";

import { isElectron } from "../../env";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { readAloudEnvironment } from "../../state/readAloud";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import {
  loadSpeechVoices,
  speak,
  speechAvailable,
  webSpeechAvailable,
  stopSpeaking,
  useSpeechPlayback,
} from "../../speech/speechPlayer";
import { speakableText } from "../../speech/speechText";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PREVIEW_TEXT =
  "Hi, I'm reading from Continuum. The tests passed, and the change is ready for review.";

function patchSpeech(current: SpeechSettings, patch: Partial<SpeechSettings>) {
  void updateClientSettings({ speech: { ...current, ...patch } });
}

/** Voices grouped by language, with the user's language first. */
function sortVoices(voices: ReadonlyArray<SpeechSynthesisVoice>): SpeechSynthesisVoice[] {
  const preferred = (navigator.language || "en").split("-")[0]?.toLowerCase() ?? "en";
  return [...voices].toSorted((left, right) => {
    const leftPreferred = left.lang.toLowerCase().startsWith(preferred) ? 0 : 1;
    const rightPreferred = right.lang.toLowerCase().startsWith(preferred) ? 0 : 1;
    return (
      leftPreferred - rightPreferred ||
      left.lang.localeCompare(right.lang) ||
      left.name.localeCompare(right.name)
    );
  });
}

function sliderStyle(value: number, min: number, max: number) {
  const ratio = (value - min) / (max - min);
  return {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
}

function SpeechSlider(props: {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="flex w-full items-center gap-3 sm:w-56">
      <output
        className="min-w-14 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums"
        htmlFor={props.id}
      >
        {props.format(props.value)}
      </output>
      <input
        aria-label={props.label}
        className="settings-slider min-w-0 flex-1"
        id={props.id}
        min={props.min}
        max={props.max}
        step={props.step}
        style={sliderStyle(props.value, props.min, props.max)}
        type="range"
        value={props.value}
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
      />
    </div>
  );
}

/** Settings → Voice → Read aloud: text-to-speech for agent messages on this device. */
export function ReadAloudSettings() {
  const speech = useClientSettings((settings) => settings.speech);
  const previewing = useSpeechPlayback(
    (state) => state.sourceId === "settings-preview" && state.status !== "idle",
  );
  const [voices, setVoices] = useState<SpeechSynthesisVoice[] | null>(null);
  const [newWord, setNewWord] = useState({ from: "", to: "" });
  const available = webSpeechAvailable();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const hostQuery = useEnvironmentQuery(
    primaryEnvironmentId === null
      ? null
      : readAloudEnvironment.status({ environmentId: primaryEnvironmentId, input: {} }),
  );
  const host = hostQuery.data;
  const usable = speechAvailable(speech);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the OS voice list, which the browser loads asynchronously and can change
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    const refresh = () =>
      void loadSpeechVoices().then((loaded) => {
        if (!cancelled) setVoices(sortVoices(loaded));
      });
    refresh();
    window.speechSynthesis.addEventListener("voiceschanged", refresh);
    return () => {
      cancelled = true;
      window.speechSynthesis.removeEventListener("voiceschanged", refresh);
    };
  }, [available]);

  const selectedVoice = voices?.find((voice) => voice.voiceURI === speech.voice) ?? null;
  const preview = () => {
    if (previewing) {
      stopSpeaking();
      return;
    }
    speak(speakableText(PREVIEW_TEXT, speech), speech, {
      id: "settings-preview",
      label: "Voice preview",
    });
  };

  return (
    <SettingsSection id={searchableSetting("read-aloud").id} title="Read aloud">
      <SettingsRow
        {...searchableSetting("read-aloud")}
        description={
          usable
            ? "Read new agent messages aloud. Speech is generated on your own machine; nothing is sent to a speech service unless you pick an online voice."
            : "No speech engine is available. Choose another engine below."
        }
        control={
          <Switch
            aria-label="Read agent messages aloud"
            disabled={!usable}
            checked={speech.autoRead}
            onCheckedChange={(checked) => {
              if (!checked) stopSpeaking();
              patchSpeech(speech, { autoRead: checked });
            }}
          />
        }
      />
      <SettingsRow
        id="read-aloud-mode"
        title="When to read"
        description="Completed reads a message once the agent finishes it. As it streams reads each finished sentence while the agent writes."
        control={
          <Select
            value={speech.readMode}
            onValueChange={(value) => {
              if (value === "completed" || value === "streaming") {
                patchSpeech(speech, { readMode: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-44" aria-label="When to read">
              <SelectValue>
                {speech.readMode === "completed" ? "Completed messages" : "As it streams"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="completed">
                Completed messages
              </SelectItem>
              <SelectItem hideIndicator value="streaming">
                As it streams
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        id="read-aloud-engine"
        title="Speech engine"
        description={
          speech.engine === "host"
            ? (host?.note ??
              "Speech plays on the machine running the Continuum server, through its own speech engine.")
            : "Voices from this browser or desktop app."
        }
        control={
          <Select
            value={speech.engine}
            onValueChange={(value) => {
              if (value === "system" || value === "host") {
                stopSpeaking();
                patchSpeech(speech, { engine: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-56" aria-label="Speech engine">
              <SelectValue>
                {speech.engine === "host" ? "This computer's speech engine" : "Browser voices"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="system">
                Browser voices
              </SelectItem>
              <SelectItem hideIndicator value="host" disabled={!host?.engine}>
                <span className="flex flex-col">
                  <span>This computer's speech engine</span>
                  <span className="text-muted-foreground text-xs">
                    {host?.engine
                      ? `${host.engine} · ${host.voices.length} voices`
                      : "Not available on this machine"}
                  </span>
                </span>
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {speech.engine === "host" ? (
        <SettingsRow
          id="read-aloud-host-voice"
          title="Voice"
          description={
            host === null
              ? "Loading voices…"
              : `${host.voices.length} voices from ${host.engine ?? "no engine"}.`
          }
          control={
            <div className="flex items-center gap-2">
              <Select
                value={speech.hostVoice}
                disabled={!host || host.voices.length === 0}
                onValueChange={(value) => patchSpeech(speech, { hostVoice: value ?? "" })}
              >
                <SelectTrigger size="sm" className="w-56" aria-label="Voice">
                  <SelectValue>
                    {host?.voices.find((voice) => voice.id === speech.hostVoice)?.name ??
                      "Engine default"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false} className="max-h-80">
                  <SelectItem hideIndicator value="">
                    Engine default
                  </SelectItem>
                  {(host?.voices ?? []).map((voice) => (
                    <SelectItem key={voice.id} hideIndicator value={voice.id}>
                      <span className="flex flex-col">
                        <span>{voice.name}</span>
                        <span className="text-muted-foreground text-xs">
                          {voice.language}
                          {voice.module ? ` · ${voice.module}` : ""}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!usable}
                aria-label={previewing ? "Stop the preview" : "Preview the voice"}
                onClick={preview}
              >
                {previewing ? <SquareIcon /> : <PlayIcon />}
              </Button>
            </div>
          }
        />
      ) : (
        <SettingsRow
          id="read-aloud-voice"
          title="Voice"
          description={
            voices === null
              ? "Loading voices…"
              : voices.length === 0
                ? isElectron
                  ? "No browser voices here. Choose This computer's speech engine above."
                  : "No voices found. Install voices in your operating system's speech settings."
                : `${voices.length} voices from your system. Natural or neural voices appear here when your OS provides them.`
          }
          control={
            <div className="flex items-center gap-2">
              <Select
                value={speech.voice}
                disabled={!voices || voices.length === 0}
                onValueChange={(value) => patchSpeech(speech, { voice: value ?? "" })}
              >
                <SelectTrigger size="sm" className="w-56" aria-label="Voice">
                  <SelectValue>
                    {selectedVoice
                      ? `${selectedVoice.name} (${selectedVoice.lang})`
                      : "System default"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false} className="max-h-80">
                  <SelectItem hideIndicator value="">
                    System default
                  </SelectItem>
                  {(voices ?? []).map((voice) => (
                    <SelectItem key={voice.voiceURI} hideIndicator value={voice.voiceURI}>
                      <span className="flex flex-col">
                        <span>{voice.name}</span>
                        <span className="text-muted-foreground text-xs">
                          {voice.lang}
                          {voice.localService ? " · on this device" : " · online voice"}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!usable}
                aria-label={previewing ? "Stop the preview" : "Preview the voice"}
                onClick={preview}
              >
                {previewing ? <SquareIcon /> : <PlayIcon />}
              </Button>
            </div>
          }
        />
      )}
      {speech.engine === "system" && selectedVoice && !selectedVoice.localService ? (
        <p className="px-4 pb-2 text-muted-foreground text-xs">
          This voice is provided online by your browser or OS vendor, so message text is sent to
          their service to be spoken. Pick a voice marked "on this device" to keep it local.
        </p>
      ) : null}
      <SettingsRow
        id="read-aloud-rate"
        title="Speed"
        control={
          <SpeechSlider
            id="read-aloud-rate-input"
            label="Speaking speed"
            value={speech.rate}
            min={0.5}
            max={2.5}
            step={0.1}
            format={(value) => `${value.toFixed(1)}×`}
            onChange={(rate) => patchSpeech(speech, { rate })}
          />
        }
      />
      <SettingsRow
        id="read-aloud-pitch"
        title="Pitch"
        control={
          <SpeechSlider
            id="read-aloud-pitch-input"
            label="Pitch"
            value={speech.pitch}
            min={0.5}
            max={1.5}
            step={0.05}
            format={(value) => value.toFixed(2)}
            onChange={(pitch) => patchSpeech(speech, { pitch })}
          />
        }
      />
      <SettingsRow
        id="read-aloud-volume"
        title="Volume"
        control={
          <SpeechSlider
            id="read-aloud-volume-input"
            label="Speech volume"
            value={speech.volume}
            min={0}
            max={1}
            step={0.05}
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(volume) => patchSpeech(speech, { volume })}
          />
        }
      />
      <SettingsRow
        id="read-aloud-content"
        title="What to read"
        description="Code blocks and terminal output are summarized as one short phrase unless you turn them on."
        control={
          <div className="flex flex-col gap-2 text-sm">
            <label className="flex items-center justify-end gap-2">
              Code blocks
              <Switch
                checked={speech.readCodeBlocks}
                onCheckedChange={(checked) => patchSpeech(speech, { readCodeBlocks: checked })}
              />
            </label>
            <label className="flex items-center justify-end gap-2">
              Terminal output
              <Switch
                checked={speech.readTerminalOutput}
                onCheckedChange={(checked) => patchSpeech(speech, { readTerminalOutput: checked })}
              />
            </label>
          </div>
        }
      />
      <SettingsRow
        id="read-aloud-length"
        title="Longest message"
        description="Longer messages stop at a sentence near this length."
        control={
          <Select
            value={String(speech.maxCharacters)}
            onValueChange={(value) => patchSpeech(speech, { maxCharacters: Number(value) })}
          >
            <SelectTrigger size="sm" className="w-40" aria-label="Longest message">
              <SelectValue>{speech.maxCharacters.toLocaleString()} characters</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {[500, 1_000, 2_000, 4_000, 8_000, 20_000].map((value) => (
                <SelectItem key={value} hideIndicator value={String(value)}>
                  {value.toLocaleString()} characters
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        id="read-aloud-thread-switch"
        title="Stop when switching threads"
        control={
          <Switch
            checked={speech.stopOnThreadSwitch}
            onCheckedChange={(checked) => patchSpeech(speech, { stopOnThreadSwitch: checked })}
          />
        }
      />
      <SettingsRow
        id="read-aloud-pronunciations"
        title="Pronunciations"
        description="Words the voice should say differently, such as nginx → engine x."
      >
        <div className="flex flex-col gap-2">
          {speech.pronunciations.map((entry, index) => (
            <div key={`${entry.from}→${entry.to}`} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono">{entry.from}</span>
              <span className="text-muted-foreground">→</span>
              <span className="min-w-0 flex-1 truncate">{entry.to}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${entry.from}`}
                onClick={() =>
                  patchSpeech(speech, {
                    pronunciations: speech.pronunciations.filter((_, at) => at !== index),
                  })
                }
              >
                <XIcon />
              </Button>
            </div>
          ))}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!newWord.from.trim() || !newWord.to.trim()) return;
              patchSpeech(speech, {
                pronunciations: [
                  ...speech.pronunciations,
                  { from: newWord.from.trim(), to: newWord.to.trim() },
                ],
              });
              setNewWord({ from: "", to: "" });
            }}
          >
            <Input
              size="sm"
              placeholder="Word"
              aria-label="Word"
              value={newWord.from}
              onChange={(event) => setNewWord((word) => ({ ...word, from: event.target.value }))}
            />
            <Input
              size="sm"
              placeholder="Say it as"
              aria-label="Say it as"
              value={newWord.to}
              onChange={(event) => setNewWord((word) => ({ ...word, to: event.target.value }))}
            />
            <Button size="sm" type="submit" variant="outline">
              <PlusIcon /> Add
            </Button>
          </form>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
