import { useState } from "react";
import { ScrollView } from "react-native";
import {
  AuthSettingsWriteScope,
  SpeechOutputSettings as SpeechOutputSchema,
} from "@t3tools/contracts";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { Sheet } from "../../components/ui/Sheet";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSpeechOutputDestination } from "../voice-output/useSpeechOutputDestination";
import { useSpeechVoiceCatalog } from "../voice-output/useSpeechVoiceCatalog";
import { SettingsSection } from "./components/SettingsSection";
import { LocalSpeechVoices } from "./LocalSpeechVoices";

export function SpeechOutputSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const { destination, choose } = useSpeechOutputDestination();
  const [choosing, setChoosing] = useState(false);
  const chosen = environments.find(
    (environment) => environment.environmentId === destination?.environmentId,
  );
  const available = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.voiceSynthesis,
  );
  return (
    <>
      <SettingsSection
        title="Response playback"
        footer="Where response text is turned into speech. Off until you choose a destination on this device."
      >
        <ListActionRow
          label="Read aloud with"
          detail={
            destination
              ? `${destination.engine === "openai" ? "OpenAI via " : ""}${chosen?.label ?? "Unavailable environment"}`
              : "Off"
          }
          onPress={() => setChoosing(true)}
        />
      </SettingsSection>
      {choosing ? (
        <Sheet title="Read aloud with" onClose={() => setChoosing(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-3 p-4 pb-10"
          >
            <ListSection>
              <ListChoiceRow
                label="Off"
                selected={!destination}
                onPress={() => {
                  choose(null);
                  setChoosing(false);
                }}
              />
            </ListSection>
            <ListSection title="On an environment">
              {available.map((environment, index) => (
                <ListChoiceRow
                  key={environment.environmentId}
                  label={environment.label}
                  selected={
                    destination?.engine === "piper" &&
                    destination.environmentId === environment.environmentId
                  }
                  separated={index > 0}
                  onPress={() => {
                    choose({ environmentId: environment.environmentId, engine: "piper" });
                    setChoosing(false);
                  }}
                />
              ))}
            </ListSection>
            {available.map((environment) => (
              <ListSection key={environment.environmentId} title={`Cloud via ${environment.label}`}>
                <ListChoiceRow
                  label="OpenAI"
                  description="Sends response text to OpenAI. API charges apply."
                  selected={
                    destination?.engine === "openai" &&
                    destination.environmentId === environment.environmentId
                  }
                  onPress={() => {
                    choose({ environmentId: environment.environmentId, engine: "openai" });
                    setChoosing(false);
                  }}
                />
              </ListSection>
            ))}
          </ScrollView>
        </Sheet>
      ) : null}
      {chosen && destination ? (
        destination.engine === "piper" ? (
          <LocalPlaybackSettings key={chosen.environmentId} environment={chosen} />
        ) : (
          <OpenAiPlaybackSettings key={chosen.environmentId} environment={chosen} />
        )
      ) : null}
    </>
  );
}

function LocalPlaybackSettings({ environment }: { environment: EnvironmentPresentation }) {
  const catalog = useSpeechVoiceCatalog(environment.environmentId);
  return (
    <SettingsSection
      title={`Piper · ${environment.label}`}
      footer={
        catalog.error ??
        catalog.runtime?.reason ??
        (catalog.runtime?.state === "ready"
          ? "Runs locally without sending text to a cloud provider."
          : catalog.runtime
            ? `Download Piper for ${catalog.runtime.platform}. No manual installation needed.`
            : "Reconnect or update this environment to manage Piper.")
      }
    >
      {catalog.runtime ? (
        <ListActionRow
          label={
            catalog.runtime.state === "ready"
              ? "Remove Piper"
              : catalog.runtime.state === "installing"
                ? "Cancel installation"
                : "Download Piper"
          }
          description={catalog.runtime.state === "installing" ? "Installing Piper…" : undefined}
          tone={catalog.runtime.state === "ready" ? "danger" : "default"}
          disabled={!catalog.canManage || catalog.busy || catalog.runtime.state === "unsupported"}
          onPress={() =>
            void catalog.run(
              "",
              catalog.runtime?.state === "ready"
                ? "removeRuntime"
                : catalog.runtime?.state === "installing"
                  ? "cancelRuntime"
                  : "installRuntime",
            )
          }
        />
      ) : catalog.error ? (
        <ListActionRow label="Try again" onPress={() => void catalog.refresh()} />
      ) : (
        <ListActionRow label="Checking this environment…" disabled onPress={() => {}} />
      )}
      {catalog.runtime?.state === "ready" ? <LocalSpeechVoices environment={environment} /> : null}
    </SettingsSection>
  );
}

function OpenAiPlaybackSettings({ environment }: { environment: EnvironmentPresentation }) {
  const config = environment.serverConfig?.settings.speechOutput;
  const canManage = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [choosing, setChoosing] = useState(false);
  if (!config) return null;
  return (
    <>
      <SettingsSection
        title="OpenAI voice"
        footer={`Uses the API key saved under Cloud providers on ${environment.label}.`}
      >
        <ListActionRow
          label="Voice"
          detail={config.voice}
          disabled={!canManage}
          onPress={() => setChoosing(true)}
        />
      </SettingsSection>
      {choosing ? (
        <Sheet title="OpenAI voice" onClose={() => setChoosing(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-3 p-4 pb-10"
          >
            <ListSection>
              {SpeechOutputSchema.fields.voice.literals.map((voice, index) => (
                <ListChoiceRow
                  key={voice}
                  label={voice}
                  selected={voice === config.voice}
                  disabled={!canManage}
                  separated={index > 0}
                  onPress={() => {
                    void update({
                      environmentId: environment.environmentId,
                      input: { patch: { speechOutput: { voice } } },
                    });
                    setChoosing(false);
                  }}
                />
              ))}
            </ListSection>
          </ScrollView>
        </Sheet>
      ) : null}
    </>
  );
}
