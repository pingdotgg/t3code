import { useGT, T } from "gt-react-native";
import { useSpeechOutputDestination } from "../voice-output/useSpeechOutputDestination";
import { useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import type { EnvironmentPresentation } from "../../state/environments";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { Progress } from "../../components/ui/Progress";
import { Sheet } from "../../components/ui/Sheet";
import { formatBytes } from "../../lib/formatBytes";
import { useSpeechVoiceCatalog } from "../voice-output/useSpeechVoiceCatalog";

export function LocalSpeechVoices({ environment }: { environment: EnvironmentPresentation }) {
  const gt = useGT();
  const { destination } = useSpeechOutputDestination();
  const catalog = useSpeechVoiceCatalog(environment.environmentId);
  const voiceId =
    destination?.voice ?? environment.serverConfig?.settings.speechOutput.piperVoiceId;
  const active = catalog.voices.find(
    (voice) => voice.id === voiceId && voice.state === "installed",
  );
  const [open, setOpen] = useState(false);
  return (
    <>
      <ListActionRow
        label={gt("Local voice")}
        description={active?.name ?? gt("Choose language and voice")}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <VoicePicker environment={environment} catalog={catalog} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function VoicePicker({
  environment,
  catalog,
  onClose,
}: {
  environment: EnvironmentPresentation;
  catalog: ReturnType<typeof useSpeechVoiceCatalog>;
  onClose: () => void;
}) {
  const gt = useGT();
  const { destination, selectVoice, canManage } = useSpeechOutputDestination();
  const [choice, setChoice] = useState<{ language: string; voiceId: string } | null>(null);
  const [choosingLanguage, setChoosingLanguage] = useState(false);
  const languages = [
    ...new Map(catalog.voices.map((voice) => [voice.language, voice.languageName])).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));
  const activeId = destination?.voice ?? catalog.voices.find((voice) => voice.active)?.id;
  const active = catalog.voices.find(
    (voice) => voice.id === activeId && voice.state === "installed",
  );
  const language =
    choice?.language ??
    active?.language ??
    languages.find(([code]) => code === Intl.DateTimeFormat().resolvedOptions().locale)?.[0] ??
    languages[0]?.[0];
  const options = catalog.voices.filter((voice) => voice.language === language);
  const selected =
    options.find((voice) => voice.id === choice?.voiceId) ??
    options.find((voice) => voice.id === activeId) ??
    options[0];
  const disabled = !canManage || !catalog.canManage || catalog.busy || catalog.downloading;
  return (
    <Sheet title={gt("Local voices · {label}", { label: environment.label })} onClose={onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 p-4 pb-10"
      >
        <Text className="px-2 text-sm text-foreground-muted">
          {active
            ? gt("Selected: {name} · {languageName}.", {
                name: active.name,
                languageName: active.languageName,
              })
            : gt("Download a voice to start listening.")}{" "}
          <T>Voices are stored on this environment.</T>
        </Text>
        {catalog.error ? (
          <ListSection footer={catalog.error}>
            <ListActionRow label={gt("Try again")} onPress={() => void catalog.refresh()} />
          </ListSection>
        ) : null}
        {!catalog.connected ? (
          <Text className="text-foreground-muted">
            <T>Connect to this environment to manage local voices.</T>
          </Text>
        ) : null}
        {catalog.loading ? (
          <Text className="text-foreground-muted">
            <T>Loading voices…</T>
          </Text>
        ) : null}
        {catalog.transfer ? (
          <ListSection
            title={
              catalog.transfer.state === "verifying"
                ? gt("Verifying {name}", { name: catalog.transfer.name })
                : gt("Downloading {name}", { name: catalog.transfer.name })
            }
          >
            <View className="p-4">
              <Progress
                label={gt("Voice download progress")}
                value={(catalog.transfer.downloaded ?? 0) / catalog.transfer.size}
              />
              <Text className="mt-2 text-sm text-foreground-muted">
                {formatBytes(catalog.transfer.downloaded ?? 0)} /{" "}
                {formatBytes(catalog.transfer.size)}
              </Text>
            </View>
            <ListActionRow
              label={gt("Cancel download")}
              disabled={
                !catalog.canManage ||
                catalog.busy ||
                !["downloading", "verifying"].includes(catalog.transfer.state)
              }
              onPress={() => void catalog.run(catalog.transfer!.id, "cancel")}
            />
          </ListSection>
        ) : null}
        {selected ? (
          <>
            <ListSection title={gt("Language")}>
              <ListActionRow
                label={languages.find(([code]) => code === language)?.[1] ?? gt("Choose language")}
                onPress={() => setChoosingLanguage(!choosingLanguage)}
              />
              {choosingLanguage
                ? languages.map(([code, name]) => (
                    <ListChoiceRow
                      key={code}
                      label={name}
                      selected={language === code}
                      separated
                      onPress={() => {
                        setChoice({ language: code, voiceId: "" });
                        setChoosingLanguage(false);
                      }}
                    />
                  ))
                : null}
            </ListSection>
            <ListSection title={gt("Voice")}>
              {options.map((voice, index) => (
                <ListChoiceRow
                  key={voice.id}
                  label={voice.name}
                  description={`${voice.quality} · ${formatBytes(voice.size)}${voice.state === "installed" ? gt(" · Installed") : ""}`}
                  selected={selected.id === voice.id}
                  separated={index > 0}
                  onPress={() => setChoice({ language: voice.language, voiceId: voice.id })}
                />
              ))}
            </ListSection>
            <ListSection>
              {selected.state === "installed" ? (
                <>
                  <ListActionRow
                    label={selected.id === activeId ? gt("Selected") : gt("Use voice")}
                    disabled={
                      !canManage ||
                      !catalog.connected ||
                      catalog.busy ||
                      catalog.downloading ||
                      selected.id === activeId
                    }
                    onPress={() => selectVoice(selected.id)}
                  />
                  <ListActionRow
                    label={gt("Remove voice")}
                    tone="danger"
                    disabled={disabled}
                    onPress={() =>
                      void catalog.run(selected.id, "remove").then((updated) => {
                        if (updated && selected.id === activeId) selectVoice(null);
                      })
                    }
                  />
                </>
              ) : (
                <ListActionRow
                  label={gt("Download & use voice")}
                  disabled={disabled}
                  loading={Boolean(catalog.transfer?.id === selected.id)}
                  onPress={() =>
                    void catalog.run(selected.id, "download").then((updated) => {
                      if (
                        updated?.voices.some(
                          (voice) => voice.id === selected.id && voice.state === "installed",
                        )
                      )
                        selectVoice(selected.id);
                    })
                  }
                />
              )}
              <ListActionRow
                label={gt("Voice license")}
                onPress={() => void Linking.openURL(selected.modelCardUrl)}
              />
            </ListSection>
          </>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}
