import { useGT, T } from "gt-react";
import { useSpeechOutputDestination } from "../../speech/useSpeechOutputDestination";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { useSpeechVoiceCatalog } from "../../speech/useSpeechVoiceCatalog";
import { SettingsRow } from "./settingsLayout";

export function LocalSpeechVoices({
  environment,
  catalog,
}: {
  environment: { environmentId: EnvironmentId; label: string };
  catalog: ReturnType<typeof useSpeechVoiceCatalog>;
}) {
  const gt = useGT();
  const { destination, selectVoice, canManage } = useSpeechOutputDestination();
  const [choice, setChoice] = useState<{
    environmentId: EnvironmentId;
    language: string;
    voiceId: string;
  } | null>(null);
  const languages = [
    ...new Map(catalog.voices.map((voice) => [voice.language, voice.languageName])).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const activeId = destination?.voice ?? catalog.voices.find((voice) => voice.active)?.id;
  const active = catalog.voices.find((voice) => voice.id === activeId);
  const localChoice = choice?.environmentId === environment.environmentId ? choice : null;
  const language =
    localChoice?.language ??
    active?.language ??
    languages.find(([code]) => code === navigator.language)?.[0] ??
    languages.find(([code]) => code.startsWith(navigator.language.split("-")[0]!))?.[0] ??
    languages[0]?.[0];
  const options = catalog.voices.filter((voice) => voice.language === language);
  const selected =
    options.find((voice) => voice.id === localChoice?.voiceId) ??
    options.find((voice) => voice.id === activeId) ??
    options[0];
  const disabled = !canManage || !catalog.canManage || catalog.busy || catalog.downloading;
  const progress = catalog.transfer
    ? Math.floor((100 * (catalog.transfer.downloaded ?? 0)) / catalog.transfer.size)
    : 0;
  return (
    <>
      {catalog.error ? (
        <SettingsRow
          title={gt("Local voices unavailable")}
          description={<span role="alert">{catalog.error}</span>}
          control={
            <Button variant="outline" size="sm" onClick={() => void catalog.refresh()}>
              <T>Try again</T>
            </Button>
          }
        />
      ) : null}
      {!catalog.connected || catalog.loading ? (
        <SettingsRow
          title={gt("Local voices")}
          description={
            catalog.loading
              ? gt("Loading voices…")
              : gt("Connect to an environment to manage local voices.")
          }
        />
      ) : null}
      {selected ? (
        <>
          <SettingsRow
            title={gt("Voice language")}
            description={gt("Filter the voices available for local playback.")}
            control={
              <Select
                value={language}
                onValueChange={(language) => {
                  if (language)
                    setChoice({ environmentId: environment.environmentId, language, voiceId: "" });
                }}
              >
                <SelectTrigger size="sm" aria-label={gt("Speech output language")}>
                  <SelectValue>{languages.find(([code]) => code === language)?.[1]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {languages.map(([code, name]) => (
                    <SelectItem key={code} value={code}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title={gt("Local voice")}
            description={
              active
                ? gt("Using {name} · {languageName} on {label}.", {
                    name: active.name,
                    languageName: active.languageName,
                    label: environment.label,
                  })
                : gt("Download a voice to start listening on {label}.", {
                    label: environment.label,
                  })
            }
            control={
              <Select
                value={selected.id}
                onValueChange={(voiceId) => {
                  if (voiceId && language)
                    setChoice({ environmentId: environment.environmentId, language, voiceId });
                }}
              >
                <SelectTrigger size="sm" aria-label={gt("Local speech voice")}>
                  <SelectValue>
                    {selected.name} · {selected.quality}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {options.map((voice) => (
                    <SelectItem key={voice.id} value={voice.id}>
                      {voice.name} · {voice.quality}
                      {voice.state === "installed" ? gt(" · Installed") : ""}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          >
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 pb-2">
              <p className="text-xs text-muted-foreground">
                {gt("{size} MB", { size: Math.ceil(selected.size / 1024 / 1024) })} ·{" "}
                {selected.state === "installed" ? gt("Installed") : gt("Download required")} ·{" "}
                <a
                  className="underline"
                  href={selected.modelCardUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <T>Voice license</T>
                </a>
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {selected.state === "installed" ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !canManage ||
                        !catalog.connected ||
                        catalog.busy ||
                        catalog.downloading ||
                        selected.id === activeId
                      }
                      onClick={() => selectVoice(selected.id)}
                    >
                      {selected.id === activeId ? gt("Selected") : gt("Use voice")}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive-outline"
                      disabled={disabled}
                      onClick={() => void catalog.run(selected.id, "remove")}
                    >
                      <T>Remove voice</T>
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      void catalog.run(selected.id, "download").then((updated) => {
                        if (
                          updated?.voices.some(
                            (voice) => voice.id === selected.id && voice.state === "installed",
                          )
                        )
                          selectVoice(selected.id);
                      })
                    }
                  >
                    <T>Download & use voice</T>
                  </Button>
                )}
              </div>
            </div>
          </SettingsRow>
        </>
      ) : null}
      {catalog.transfer ? (
        <SettingsRow
          title={`${catalog.transfer.state === "verifying" ? "Verifying" : "Downloading"} ${catalog.transfer.name}`}
          status={<span role="status">{gt("{progress}% downloaded", { progress })}</span>}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={
                !catalog.canManage ||
                catalog.busy ||
                !["downloading", "verifying"].includes(catalog.transfer.state)
              }
              onClick={() => void catalog.run(catalog.transfer!.id, "cancel")}
            >
              <T>Cancel download</T>
            </Button>
          }
        >
          <div className="mt-3 pb-2">
            <div
              role="progressbar"
              aria-label={gt("Voice download progress")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              className="h-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-[width] duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}
