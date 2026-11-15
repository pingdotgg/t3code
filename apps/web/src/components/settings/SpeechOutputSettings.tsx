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
        description="Listen to a response using its speaker button. Local voices run on the response’s environment."
        serverScoped
        settingKeys={["speechOutput"]}
        control={
          <Select
            value={settings.engine}
            disabled={!canManage}
            onValueChange={(value) => {
              if (value)
                update({
                  speechOutput: { engine: value === "openai" ? "openai" : "piper" },
                });
            }}
          >
            <SelectTrigger size="sm" aria-label="Speech output engine">
              <SelectValue>{settings.engine === "piper" ? "Local · Piper" : "OpenAI"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="piper">Local · Piper</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {settings.engine === "piper" ? (
        <>
          <SettingsRow
            title="Piper executable"
            description="Install piper-tts on this environment. Enter piper or the full path to its executable."
            serverScoped
            settingKeys={["speechOutput"]}
            control={
              <div className="w-full @min-[32rem]/settings-row:w-64">
                <Input
                  key={settings.piperExecutable}
                  size="sm"
                  font="mono"
                  aria-label="Piper executable"
                  defaultValue={settings.piperExecutable}
                  disabled={!canManage}
                  onBlur={(event) => {
                    const piperExecutable = event.target.value.trim();
                    if (piperExecutable !== settings.piperExecutable)
                      update({ speechOutput: { piperExecutable } });
                  }}
                />
              </div>
            }
          />
          <LocalSpeechVoices environments={scope?.connectedEnvironments ?? []} />
        </>
      ) : (
        <SettingsRow
          title="OpenAI voice"
          description="Sends response text using the key saved under Cloud providers. API charges apply."
          serverScoped
          settingKeys={["speechOutput"]}
          control={
            <Select
              value={settings.voice}
              disabled={!canManage}
              onValueChange={(value) => {
                const voice = SpeechOutputSchema.fields.voice.literals.find(
                  (voice) => voice === value,
                );
                if (voice) update({ speechOutput: { voice } });
              }}
            >
              <SelectTrigger size="sm" aria-label="Speech output voice">
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
          }
        />
      )}
    </SettingsSection>
  );
}
