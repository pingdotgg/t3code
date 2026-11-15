import { LocalSpeechVoices } from "./LocalSpeechVoices";
import {
  AuthSettingsWriteScope,
  SpeechOutputSettings as SpeechOutputSchema,
} from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { Sheet } from "../../components/ui/Sheet";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

export function SpeechOutputSettings({ environment }: { environment: EnvironmentPresentation }) {
  const config = environment.serverConfig?.settings.speechOutput;
  const canManage = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [choosingVoice, setChoosingVoice] = useState(false);
  if (!config) return null;
  const save = (patch: Partial<typeof config>) =>
    void update({
      environmentId: environment.environmentId,
      input: { patch: { speechOutput: { ...config, ...patch } } },
    });
  return (
    <>
      <SettingsSection
        title={`Response playback · ${environment.label}`}
        footer="Listen to a response using its speaker button."
      >
        <ListChoiceRow
          label="Local · Piper"
          description="Runs on this environment. Works offline after installation."
          selected={config.engine === "piper"}
          disabled={!canManage}
          onPress={() => save({ engine: "piper" })}
        />
        <ListChoiceRow
          label="OpenAI"
          description="Sends response text to OpenAI. API charges apply."
          selected={config.engine === "openai"}
          disabled={!canManage}
          onPress={() => save({ engine: "openai" })}
          separated
        />
      </SettingsSection>
      {config.engine === "piper" ? (
        <SettingsSection
          title="Local voice"
          footer="Install piper-tts on this environment, then download a voice."
        >
          <View className="gap-2 p-4">
            <Text textRole="footnote" className="text-foreground-muted">
              Piper executable
            </Text>
            <TextInput
              key={config.piperExecutable}
              accessibilityLabel="Piper executable"
              defaultValue={config.piperExecutable}
              autoCapitalize="none"
              autoCorrect={false}
              editable={canManage}
              onEndEditing={(event) => {
                const value = event.nativeEvent.text.trim();
                if (value !== config.piperExecutable) save({ piperExecutable: value });
              }}
              className="rounded-lg bg-background px-3 py-2 font-mono text-foreground"
            />
          </View>
          <LocalSpeechVoices environment={environment} />
        </SettingsSection>
      ) : (
        <SettingsSection
          title="OpenAI voice"
          footer="Uses the API key saved under Cloud providers on this environment."
        >
          <ListActionRow
            label="Voice"
            detail={config.voice}
            disabled={!canManage}
            onPress={() => setChoosingVoice(true)}
          />
        </SettingsSection>
      )}
      {choosingVoice && config.engine === "openai" ? (
        <Sheet title="OpenAI voice" onClose={() => setChoosingVoice(false)}>
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
                  onPress={() => {
                    save({ voice });
                    setChoosingVoice(false);
                  }}
                  separated={index > 0}
                />
              ))}
            </ListSection>
          </ScrollView>
        </Sheet>
      ) : null}
    </>
  );
}
