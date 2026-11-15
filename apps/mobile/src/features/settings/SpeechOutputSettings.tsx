import { LocalSpeechVoices } from "./LocalSpeechVoices";
import {
  AuthSettingsWriteScope,
  SpeechOutputSettings as SpeechOutputSchema,
} from "@t3tools/contracts";
import { TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

export function SpeechOutputSettings({ environment }: { environment: EnvironmentPresentation }) {
  const config = environment.serverConfig?.settings.speechOutput;
  const canManage = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  if (!config) return null;
  const save = (patch: Partial<typeof config>) =>
    void update({
      environmentId: environment.environmentId,
      input: { patch: { speechOutput: { ...config, ...patch } } },
    });
  return (
    <SettingsSection title={`Response playback · ${environment.label}`}>
      <ListChoiceRow
        label="Local · Piper"
        description="Synthesizes on this environment. Works offline after installation."
        selected={config.engine === "piper"}
        disabled={!canManage}
        onPress={() => save({ engine: "piper" })}
      />
      <ListChoiceRow
        label="OpenAI"
        description="Sends response text using this environment's saved OpenAI API key. API charges apply."
        selected={config.engine === "openai"}
        disabled={!canManage}
        onPress={() => save({ engine: "openai" })}
        separated
      />
      {config.engine === "piper" ? (
        <>
          <View className="gap-2 p-4">
            <Text className="text-sm text-foreground-muted">
              Install piper-tts on this environment, then choose a voice below.
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
              className="rounded-lg bg-background px-3 py-2 text-foreground"
            />
          </View>
          <LocalSpeechVoices environment={environment} />
        </>
      ) : (
        SpeechOutputSchema.fields.voice.literals.map((voice) => (
          <ListChoiceRow
            key={voice}
            label={voice}
            selected={voice === config.voice}
            disabled={!canManage}
            onPress={() => save({ voice })}
            separated
          />
        ))
      )}
    </SettingsSection>
  );
}
