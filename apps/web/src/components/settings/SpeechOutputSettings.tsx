import {
  AuthSettingsWriteScope,
  CloudSpeechApiKey,
  SpeechOutputSettings as SpeechOutputSchema,
} from "@t3tools/contracts";
import { useState } from "react";
import * as Schema from "effect/Schema";
import { CloudIcon, MonitorIcon, VolumeXIcon } from "lucide-react";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useSpeechOutputDestination } from "../../speech/useSpeechOutputDestination";
import { useSpeechVoiceCatalog } from "../../speech/useSpeechVoiceCatalog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SecretInput } from "./SecretInput";
import { DraftInput } from "../ui/draft-input";
import { Button } from "../ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
  SelectGroup,
  SelectGroupLabel,
} from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { SpeechPlaybackSpeed } from "../../speech/SpeechPlaybackSpeed";
import { LocalSpeechVoices } from "./LocalSpeechVoices";

const isApiKey = Schema.is(CloudSpeechApiKey);
const isVoiceId = Schema.is(Schema.toType(SpeechOutputSchema.fields.elevenLabsVoiceId));

export function SpeechOutputSettings() {
  const { environments } = useEnvironments();
  const { destination, choose } = useSpeechOutputDestination();
  const chosen = environments.find(
    (environment) => environment.environmentId === destination?.environmentId,
  );
  const available = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.voiceSynthesis,
  );
  const value = destination ? `${destination.engine}:${destination.environmentId}` : "off";
  return (
    <SettingsSection id="speech-output" title="Response playback">
      <SettingsRow
        title="Read aloud with"
        description="Where response text is turned into speech. Off until you choose a destination on this device."
        devicePreference
        control={
          <div className="w-full min-w-0 @min-[32rem]/settings-row:max-w-72">
            <Select
              value={value}
              onValueChange={(value) => {
                if (value === "off") {
                  choose(null);
                  return;
                }
                const picked = available.find(
                  (environment) =>
                    value === `piper:${environment.environmentId}` ||
                    value === `openai:${environment.environmentId}` ||
                    value === `elevenlabs:${environment.environmentId}`,
                );
                if (picked)
                  choose({
                    environmentId: picked.environmentId,
                    engine: value?.startsWith("elevenlabs:")
                      ? "elevenlabs"
                      : value?.startsWith("openai:")
                        ? "openai"
                        : "piper",
                  });
              }}
            >
              <SelectTrigger size="sm" aria-label="Read aloud with">
                <SelectValue>
                  <span className="flex min-w-0 items-center gap-2">
                    {destination ? (
                      destination.engine === "piper" ? (
                        <MonitorIcon aria-hidden className="size-4" />
                      ) : (
                        <CloudIcon aria-hidden className="size-4" />
                      )
                    ) : (
                      <VolumeXIcon aria-hidden className="size-4" />
                    )}
                    <span className="truncate">
                      {" "}
                      {destination
                        ? `${destination.engine === "elevenlabs" ? "ElevenLabs via " : destination.engine === "openai" ? "OpenAI via " : ""}${chosen?.label ?? "Chosen environment (unavailable)"}`
                        : "Off"}
                    </span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="off">
                  <span className="flex items-center gap-2">
                    <VolumeXIcon aria-hidden className="size-4" />
                    Off
                  </span>
                </SelectItem>
                <SelectGroup>
                  <SelectGroupLabel>On an environment</SelectGroupLabel>
                  {available.map((environment) => (
                    <SelectItem
                      key={environment.environmentId}
                      value={`piper:${environment.environmentId}`}
                    >
                      <span className="flex items-center gap-2">
                        <MonitorIcon aria-hidden className="size-4" />
                        {environment.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
                {available.map((environment) => (
                  <SelectGroup key={environment.environmentId}>
                    <SelectGroupLabel>Cloud via {environment.label}</SelectGroupLabel>
                    <SelectItem value={`openai:${environment.environmentId}`}>
                      <span className="flex items-center gap-2">
                        <CloudIcon aria-hidden className="size-4" />
                        OpenAI
                      </span>
                    </SelectItem>
                    <SelectItem value={`elevenlabs:${environment.environmentId}`}>
                      <span className="flex items-center gap-2">
                        <CloudIcon aria-hidden className="size-4" />
                        ElevenLabs
                      </span>
                    </SelectItem>
                  </SelectGroup>
                ))}
                {destination &&
                !available.some(
                  (environment) => environment.environmentId === destination.environmentId,
                ) ? (
                  <SelectItem value={value}>Chosen environment (unavailable)</SelectItem>
                ) : null}
              </SelectPopup>
            </Select>
          </div>
        }
      />
      <SettingsRow
        title="Playback speed"
        description="Adjust listening speed on this device without generating new audio."
        devicePreference
        control={<SpeechPlaybackSpeed />}
      />
      {destination && chosen ? (
        destination.engine === "piper" ? (
          <LocalPlaybackSettings key={chosen.environmentId} environment={chosen} />
        ) : destination.engine === "elevenlabs" ? (
          <ElevenLabsPlaybackSettings key={chosen.environmentId} environment={chosen} />
        ) : (
          <OpenAiPlaybackSettings key={chosen.environmentId} environment={chosen} />
        )
      ) : null}
    </SettingsSection>
  );
}

function LocalPlaybackSettings({ environment }: { environment: EnvironmentPresentation }) {
  const catalog = useSpeechVoiceCatalog(environment.environmentId);
  return (
    <>
      <SettingsRow
        title="Piper"
        description={
          catalog.loading
            ? "Checking this environment…"
            : (catalog.error ??
              catalog.runtime?.reason ??
              (catalog.runtime?.state === "ready"
                ? `Installed on ${environment.label}. Runs locally without sending text to a cloud provider.`
                : catalog.runtime?.state === "installing"
                  ? `Installing Piper on ${environment.label}…`
                  : catalog.runtime
                    ? `Download Piper for ${catalog.runtime.platform} on ${environment.label}. No manual installation needed.`
                    : "Reconnect or update this environment to manage Piper."))
        }
        control={
          catalog.runtime ? (
            <Button
              size="sm"
              variant={catalog.runtime.state === "ready" ? "ghost-destructive" : "outline"}
              disabled={
                !catalog.canManage || catalog.busy || catalog.runtime.state === "unsupported"
              }
              onClick={() =>
                void catalog.run(
                  "",
                  catalog.runtime?.state === "ready"
                    ? "removeRuntime"
                    : catalog.runtime?.state === "installing"
                      ? "cancelRuntime"
                      : "installRuntime",
                )
              }
            >
              {catalog.runtime.state === "ready"
                ? "Remove Piper"
                : catalog.runtime.state === "installing"
                  ? "Cancel installation"
                  : "Download Piper"}
            </Button>
          ) : catalog.error ? (
            <Button variant="outline" size="sm" onClick={() => void catalog.refresh()}>
              Try again
            </Button>
          ) : null
        }
      />
      {catalog.runtime?.state === "ready" ? (
        <LocalSpeechVoices environment={environment} catalog={catalog} />
      ) : null}
    </>
  );
}

function OpenAiPlaybackSettings({ environment }: { environment: EnvironmentPresentation }) {
  const config = useEnvironmentSettings(
    environment.environmentId,
    (settings) => settings.speechOutput,
  );
  const update = useUpdateEnvironmentSettings(environment.environmentId);
  const canManage = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  return (
    <SettingsRow
      title="OpenAI voice"
      description={`Sends response text via ${environment.label} using its key saved under Cloud providers. API charges apply.`}
      control={
        <Select
          value={config.voice}
          disabled={!canManage}
          onValueChange={(value) => {
            const voice = SpeechOutputSchema.fields.voice.literals.find((voice) => voice === value);
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
  );
}

function ElevenLabsPlaybackSettings({ environment }: { environment: EnvironmentPresentation }) {
  const config = useEnvironmentSettings(
    environment.environmentId,
    (settings) => settings.speechOutput,
  );
  const canManage = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const key = draft.trim();
  const saveKey = async (key: string) => {
    setSaving(true);
    const result = await update({
      environmentId: environment.environmentId,
      input: { patch: { speechOutput: { elevenLabsApiKey: key } } },
    });
    setSaving(false);
    if (result._tag === "Success") setDraft("");
  };
  return (
    <>
      <SettingsRow
        title="ElevenLabs API key"
        description={`Stored on ${environment.label}. Sends response text to ElevenLabs. API charges apply.`}
        control={
          <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:max-w-96">
            <div className="min-w-0 flex-1">
              <SecretInput
                aria-label="ElevenLabs API key"
                size="sm"
                configured={Boolean(config.elevenLabsApiKey)}
                value={draft}
                disabled={!canManage || saving}
                maxLength={4096}
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={!canManage || saving || !isApiKey(key)}
              onClick={() => void saveKey(key)}
            >
              Save
            </Button>
            {config.elevenLabsApiKey ? (
              <Button
                size="sm"
                variant="ghost-destructive"
                disabled={!canManage || saving}
                onClick={() => void saveKey("")}
              >
                Remove key
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        title="ElevenLabs voice ID"
        description="Copy a voice ID from your ElevenLabs voice library. George is selected by default."
        control={
          <div className="w-full @min-[32rem]/settings-row:max-w-72">
            <DraftInput
              aria-label="ElevenLabs voice ID"
              size="sm"
              value={config.elevenLabsVoiceId}
              disabled={!canManage}
              maxLength={128}
              spellCheck={false}
              onCommit={(value) => {
                const elevenLabsVoiceId = value.trim();
                if (isVoiceId(elevenLabsVoiceId))
                  void update({
                    environmentId: environment.environmentId,
                    input: { patch: { speechOutput: { elevenLabsVoiceId } } },
                  });
              }}
            />
          </div>
        }
      />
    </>
  );
}
