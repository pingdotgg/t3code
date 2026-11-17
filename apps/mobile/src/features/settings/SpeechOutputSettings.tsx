import { useGT } from "gt-react-native";
import { SystemSpeechSettings } from "./SystemSpeechSettings";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import {
  AuthSettingsWriteScope,
  CloudSpeechApiKey,
  isSecretReference,
  type SecretProviderId,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import Constants from "expo-constants";
import { Chip } from "../../components/ui/Chip";
import { AppTextInput } from "../../components/ui/AppText";
import {
  configuredSecretSources,
  secretRequestReference,
} from "@t3tools/client-runtime/secret-request";
import { ProviderIcon } from "../../components/ProviderIcon";
import * as Dialog from "../../components/ui/Dialog";
import { useElevenLabsVoices } from "../voice-output/useElevenLabsVoices";
import { SecretTextInput } from "../../components/ui/SecretTextInput";
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
import { SpeechPlaybackSpeed } from "../voice-output/SpeechPlaybackSpeed";
import { LocalSpeechVoices } from "./LocalSpeechVoices";

const isApiKey = Schema.is(CloudSpeechApiKey);

export function SpeechOutputSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const gt = useGT();
  const { destination, choose, canManage, mixedDestination, mixedTarget } =
    useSpeechOutputDestination();
  const [choosing, setChoosing] = useState(false);
  const [pending, setPending] = useState<{
    environment: EnvironmentPresentation;
    engine: "openai" | "elevenlabs";
  } | null>(null);
  const selectCloud = (environment: EnvironmentPresentation, engine: "openai" | "elevenlabs") => {
    const key =
      engine === "openai"
        ? environment.serverConfig?.settings.cloudSpeechCredentials.openai
        : environment.serverConfig?.settings.speechOutput.elevenLabsApiKey;
    if (key) choose({ environmentId: environment.environmentId, engine });
    else setPending({ environment, engine });
    setChoosing(false);
  };
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
        footer={gt(
          "Playback preferences follow the selected environment or project. Off by default.",
        )}
      >
        <ListActionRow
          label="Read aloud with"
          detail={
            mixedDestination
              ? gt("Mixed")
              : destination
                ? destination.engine === "system"
                  ? gt("System voices")
                  : `${destination.engine === "elevenlabs" ? "ElevenLabs via " : destination.engine === "openai" ? "OpenAI via " : ""}${chosen?.label ?? "Unavailable environment"}`
                : "Off"
          }
          disabled={!canManage}
          onPress={() => setChoosing(true)}
        />
        <SpeechPlaybackSpeed />
      </SettingsSection>
      {!mixedTarget && destination?.engine === "system" ? <SystemSpeechSettings /> : null}
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
            <ListSection>
              <ListChoiceRow
                label={gt("System voices")}
                selected={destination?.engine === "system"}
                onPress={() => {
                  choose({ engine: "system", environmentId: null });
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
                  leading={<ProviderIcon provider="openai" size={20} />}
                  description="Sends response text to OpenAI. API charges apply."
                  selected={
                    destination?.engine === "openai" &&
                    destination.environmentId === environment.environmentId
                  }
                  onPress={() => {
                    selectCloud(environment, "openai");
                  }}
                />
                <ListChoiceRow
                  label="ElevenLabs"
                  leading={<ProviderIcon provider="elevenlabs" size={20} />}
                  description="Sends response text to ElevenLabs. API charges apply."
                  separated
                  selected={
                    destination?.engine === "elevenlabs" &&
                    destination.environmentId === environment.environmentId
                  }
                  onPress={() => {
                    selectCloud(environment, "elevenlabs");
                  }}
                />
              </ListSection>
            ))}
          </ScrollView>
        </Sheet>
      ) : null}
      {!mixedTarget && chosen && destination && destination.engine !== "system" ? (
        destination.engine === "piper" ? (
          <LocalPlaybackSettings key={chosen.environmentId} environment={chosen} />
        ) : (
          <CloudPlaybackSettings
            key={`${chosen.environmentId}:${destination.engine}`}
            environment={chosen}
            engine={destination.engine}
          />
        )
      ) : null}
      {pending ? (
        <SpeechApiKeySheet
          key={`${pending.environment.environmentId}:${pending.engine}`}
          environment={pending.environment}
          engine={pending.engine}
          configured={false}
          close={() => setPending(null)}
          saved={() => {
            choose({ environmentId: pending.environment.environmentId, engine: pending.engine });
            setPending(null);
          }}
        />
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
  const gt = useGT();
  const config = environment.serverConfig?.settings.speechOutput;
  const { destination, selectVoice, canManage } = useSpeechOutputDestination();
  const catalog = useSpeechVoiceCatalog(environment.environmentId);
  const provider = catalog.providers.find((provider) => provider.id === "openai");
  const [choosing, setChoosing] = useState(false);
  if (!config) return null;
  const voiceId = destination?.voice ?? provider?.defaultVoice ?? config.voice;
  return (
    <>
      <SettingsSection
        title="OpenAI voice"
        footer={
          catalog.error ??
          (catalog.loading
            ? gt("Checking")
            : !provider
              ? gt("Unavailable")
              : "Choose the voice used for response playback.")
        }
      >
        <ListActionRow
          label="Voice"
          detail={provider?.voices.find((voice) => voice.id === voiceId)?.name ?? voiceId}
          disabled={!canManage || !provider}
          onPress={() => setChoosing(true)}
        />
        {!provider && !catalog.loading ? (
          <ListActionRow
            label={gt("Try again")}
            disabled={!catalog.connected}
            onPress={() => void catalog.refresh()}
          />
        ) : null}
      </SettingsSection>
      {choosing ? (
        <Sheet title="OpenAI voice" onClose={() => setChoosing(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-3 p-4 pb-10"
          >
            <ListSection>
              {(provider?.voices ?? []).map((voice, index) => (
                <ListChoiceRow
                  key={voice.id}
                  label={voice.name}
                  selected={
                    voice.id === (destination?.voice ?? provider?.defaultVoice ?? config.voice)
                  }
                  disabled={!canManage}
                  separated={index > 0}
                  onPress={() => {
                    selectVoice(voice.id);
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

function CloudPlaybackSettings({
  environment,
  engine,
}: {
  environment: EnvironmentPresentation;
  engine: "openai" | "elevenlabs";
}) {
  const settings = environment.serverConfig?.settings;
  const configured = Boolean(
    engine === "openai"
      ? settings?.cloudSpeechCredentials.openai
      : settings?.speechOutput.elevenLabsApiKey,
  );
  const canManage = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const [configuring, setConfiguring] = useState(false);
  const [revision, setRevision] = useState(0);
  const label = engine === "openai" ? "OpenAI" : "ElevenLabs";
  return (
    <>
      <SettingsSection
        title={label}
        footer={`Response text is sent via ${environment.label} to ${label}. API charges apply.`}
      >
        <ListActionRow
          label="API key"
          leading={<ProviderIcon provider={engine} size={20} />}
          detail={configured ? "Saved" : "Not set"}
          description={configured ? "Tap to manage key" : "Add an API key to choose a voice"}
          disabled={!canManage}
          onPress={() => setConfiguring(true)}
        />
      </SettingsSection>
      {configured ? (
        engine === "openai" ? (
          <OpenAiPlaybackSettings environment={environment} />
        ) : (
          <ElevenLabsVoiceSettings key={revision} environment={environment} />
        )
      ) : null}
      {configuring ? (
        <SpeechApiKeySheet
          environment={environment}
          engine={engine}
          configured={configured}
          close={() => setConfiguring(false)}
          saved={() => {
            setRevision((value) => value + 1);
            setConfiguring(false);
          }}
        />
      ) : null}
    </>
  );
}

function SpeechApiKeySheet({
  environment,
  engine,
  configured,
  close,
  saved,
}: {
  environment: EnvironmentPresentation;
  engine: "openai" | "elevenlabs";
  configured: boolean;
  close: () => void;
  saved: () => void;
}) {
  const canManage = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const original =
    engine === "openai"
      ? environment.serverConfig?.settings.cloudSpeechCredentials.openai
      : environment.serverConfig?.settings.speechOutput.elevenLabsApiKey;
  const sources =
    Constants.expoConfig?.extra?.secretsFeatureEnabled === true &&
    environment.serverConfig?.secretReferences
      ? configuredSecretSources(environment.serverConfig.settings.secretProviders)
      : [];
  const reference =
    isSecretReference(original) && sources.some((source) => source.id === original.provider)
      ? original
      : null;
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(reference?.provider ?? null);
  const [draft, setDraft] = useState(reference?.reference ?? "");
  const source = sources.find((source) => source.id === sourceId);
  const credentialFor = (value: string) =>
    sourceId !== null
      ? source && secretRequestReference(source, value)
      : isApiKey(value.trim())
        ? value.trim()
        : undefined;
  const credential = credentialFor(draft);
  const [busy, setBusy] = useState(false);
  const label = engine === "openai" ? "OpenAI" : "ElevenLabs";
  const commit = async (key: SettingsSecretValue) => {
    if (!canManage || busy) return;
    setBusy(true);
    const result = await update({
      environmentId: environment.environmentId,
      input: {
        patch:
          engine === "openai"
            ? { cloudSpeechCredentials: { openai: key } }
            : { speechOutput: { elevenLabsApiKey: key } },
      },
    });
    setBusy(false);
    if (result._tag === "Success") saved();
  };
  return (
    <Sheet
      title={`${configured ? "Manage" : "Add"} ${label} API key`}
      dismissDisabled={busy}
      onClose={close}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-5 pt-2 pb-8"
      >
        <ListSection
          title="API key"
          footer={`Stored on ${environment.label}. Response text is sent to ${label}. API charges apply.${engine === "openai" ? " This key is shared with OpenAI transcription." : " Allow Voices: Read to list your voices."}`}
        >
          <View className="gap-3 px-4 py-3">
            {sources.length > 0 ? (
              <View className="flex-row flex-wrap gap-2">
                <Chip
                  label="Value"
                  size="small"
                  selected={sourceId === null}
                  disabled={!canManage || busy}
                  onPress={() => {
                    setSourceId(null);
                    setDraft("");
                  }}
                />
                {sources.map((source) => (
                  <Chip
                    key={source.id}
                    label={source.label}
                    size="small"
                    selected={sourceId === source.id}
                    disabled={!canManage || busy}
                    onPress={() => {
                      setSourceId(source.id);
                      setDraft("");
                    }}
                  />
                ))}
              </View>
            ) : null}
            {sourceId !== null ? (
              <AppTextInput
                accessibilityLabel={`${label} API key reference`}
                value={draft}
                placeholder={source?.referencePlaceholder}
                editable={canManage && !busy}
                autoCorrect={false}
                autoCapitalize="none"
                autoComplete="off"
                maxLength={4096}
                onChangeText={setDraft}
                onSubmitEditing={(event) => {
                  const key = credentialFor(event.nativeEvent.text);
                  if (key && !busy) void commit(key);
                }}
              />
            ) : (
              <SecretTextInput
                accessibilityLabel={`${label} API key`}
                placeholder={
                  configured ? "Saved key · enter a new one to replace" : "Enter API key"
                }
                value={draft}
                onChangeText={setDraft}
                editable={canManage && !busy}
                onSubmitEditing={(value) => {
                  const key = credentialFor(value);
                  if (key && !busy) void commit(key);
                }}
              />
            )}
          </View>
          <ListActionRow
            label="Save key"
            loading={busy}
            disabled={!canManage || !credential}
            onPress={() => {
              if (credential) void commit(credential);
            }}
          />
          {configured ? (
            <ListActionRow
              label="Remove key from environment"
              tone="danger"
              disabled={busy}
              onPress={() =>
                Dialog.confirm({
                  title: `Remove the ${label} key from ${environment.label}?`,
                  message: `Everyone using ${label} on this environment will lose access to this key.`,
                  confirmText: "Remove key",
                  destructive: true,
                  onConfirm: () => void commit(""),
                })
              }
            />
          ) : null}
        </ListSection>
        <ListSection>
          <ListActionRow label="Cancel" disabled={busy} onPress={close} />
        </ListSection>
      </ScrollView>
    </Sheet>
  );
}

function ElevenLabsVoiceSettings({ environment }: { environment: EnvironmentPresentation }) {
  const config = environment.serverConfig?.settings.speechOutput;
  const catalog = useElevenLabsVoices(environment.environmentId);
  const { destination, selectVoice, canManage } = useSpeechOutputDestination();
  const [choosing, setChoosing] = useState(false);
  if (!config) return null;
  const selected = catalog.voices.find(
    (voice) => voice.id === (destination?.voice ?? config.elevenLabsVoiceId),
  );
  const status = !catalog.connected
    ? "Connect with playback access to load voices."
    : catalog.failed
      ? "Could not load voices. Check the API key has Voices: Read permission, then try again."
      : catalog.loading
        ? "Loading voices…"
        : catalog.voices.length === 0
          ? "No voices are available for this API key."
          : undefined;
  return (
    <>
      <SettingsSection title="ElevenLabs voice" footer={status}>
        <ListActionRow
          label="Voice"
          detail={selected?.name ?? "Current voice"}
          disabled={!canManage || !catalog.connected || catalog.voices.length === 0}
          onPress={() => setChoosing(true)}
        />
        <ListActionRow
          label={catalog.failed ? "Try again" : "Refresh voices"}
          disabled={!catalog.connected || catalog.loading}
          onPress={catalog.refresh}
        />
      </SettingsSection>
      {choosing ? (
        <Sheet title="ElevenLabs voice" onClose={() => setChoosing(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-3 p-4 pb-10"
          >
            <ListSection>
              {catalog.voices.map((voice, index) => (
                <ListChoiceRow
                  key={voice.id}
                  label={voice.name}
                  separated={index > 0}
                  selected={voice.id === (destination?.voice ?? config.elevenLabsVoiceId)}
                  disabled={!canManage}
                  onPress={() => {
                    selectVoice(voice.id);
                    setChoosing(false);
                  }}
                />
              ))}
              {catalog.hasMore ? (
                <ListActionRow
                  label="Load more voices"
                  disabled={catalog.loading}
                  onPress={catalog.loadMore}
                />
              ) : null}
              {catalog.failed ? (
                <ListActionRow label="Try again" onPress={catalog.refresh} />
              ) : null}
            </ListSection>
          </ScrollView>
        </Sheet>
      ) : null}
    </>
  );
}
