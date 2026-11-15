import { LocalSpeechVoices } from "./LocalSpeechVoices";
import {
  AuthSettingsWriteScope,
  SpeechOutputSettings as SpeechOutputSchema,
} from "@t3tools/contracts";
import { useEnvironmentScope } from "../../state/session";
import { Input } from "../ui/input";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function SpeechOutputSettings() {
  const scope = useOptionalSettingsScope();
  const settings = useScopedSettings((value) => value.speechOutput);
  const update = useUpdateScopedSettings();
  const canManage = useEnvironmentScope(
    scope?.target?.environmentId ?? null,
    AuthSettingsWriteScope,
  );
  return (
    <SettingsSection id="speech-output" title="Response playback">
      <SettingsRow
        title="Speech engine"
        description="Read individual assistant responses using the speaker button. Local synthesis runs on the response's environment."
        serverScoped
        settingKeys={["speechOutput"]}
      >
        <Select
          value={settings.engine}
          disabled={!canManage}
          onValueChange={(value) => {
            if (value)
              update({
                speechOutput: { ...settings, engine: value === "openai" ? "openai" : "piper" },
              });
          }}
        >
          <SelectTrigger aria-label="Speech output engine">
            <SelectValue>{settings.engine === "piper" ? "Local · Piper" : "OpenAI"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="piper">Local · Piper</SelectItem>
            <SelectItem value="openai">OpenAI · sends response text</SelectItem>
          </SelectPopup>
        </Select>
      </SettingsRow>
      {settings.engine === "piper" ? (
        <>
          <SettingsRow
            title="Piper executable"
            description="Install piper-tts on this environment. Enter piper or the full path to its executable."
            serverScoped
            settingKeys={["speechOutput"]}
          >
            <Input
              key={settings.piperExecutable}
              aria-label="Piper executable"
              defaultValue={settings.piperExecutable}
              disabled={!canManage}
              onBlur={(event) => {
                const piperExecutable = event.target.value.trim();
                if (piperExecutable !== settings.piperExecutable)
                  update({ speechOutput: { ...settings, piperExecutable } });
              }}
            />
          </SettingsRow>
          <LocalSpeechVoices environments={scope?.connectedEnvironments ?? []} />
        </>
      ) : (
        <SettingsRow
          title="OpenAI voice"
          description="Uses the OpenAI key saved under Cloud providers in Voice settings. API usage is billed separately. Local errors never switch to OpenAI automatically."
          serverScoped
          settingKeys={["speechOutput"]}
        >
          <Select
            value={settings.voice}
            disabled={!canManage}
            onValueChange={(value) => {
              const voice = SpeechOutputSchema.fields.voice.literals.find(
                (voice) => voice === value,
              );
              if (voice) update({ speechOutput: { ...settings, voice } });
            }}
          >
            <SelectTrigger aria-label="Speech output voice">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {SpeechOutputSchema.fields.voice.literals.map((voice) => (
                <SelectItem key={voice} value={voice}>
                  {voice}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}
