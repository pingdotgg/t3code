import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { setCloudSpeechKey } from "@t3tools/client-runtime/voice-input";
import {
  configuredSecretSources,
  secretRequestReference,
} from "@t3tools/client-runtime/secret-request";
import {
  AuthSettingsWriteScope,
  CLOUD_SPEECH_LABELS,
  CLOUD_SPEECH_PROVIDER_NAMES,
  CloudSpeechProvider,
  CloudSpeechApiKey,
  isSecretReference,
  type SecretProviderId,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import Constants from "expo-constants";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { TextInput, View } from "react-native";
import * as Dialog from "../../components/ui/Dialog";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { Chip } from "../../components/ui/Chip";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import {
  pendingCloudVoiceChoice,
  cloudVoiceConnectionAtom,
  cloudVoiceKeysAtom,
  runSpeech,
} from "../voice-input/voiceDestination";
import { SettingsSection } from "./components/SettingsSection";

type Props = { environment: EnvironmentPresentation; active: CloudSpeechProvider | null };
const isApiKey = Schema.is(CloudSpeechApiKey);

export function CloudVoiceSection({ environment, active }: Props) {
  const [open, setOpen] = useState(active !== null);
  return (
    <SettingsSection title={`Cloud via ${environment.label}`}>
      <ListActionRow
        label={open ? "Hide cloud providers" : "Cloud providers"}
        description={
          active ? `Using ${CLOUD_SPEECH_LABELS[active]}` : "Optional · use your own API key"
        }
        onPress={() => setOpen(!open)}
      />
      {open && <CloudChoices environment={environment} active={active} />}
    </SettingsSection>
  );
}

function CloudChoices({ environment, active }: Props) {
  const id = environment.environmentId;
  const connection = useAtomValue(cloudVoiceConnectionAtom(id));
  const keys = useAtomValue(cloudVoiceKeysAtom(id));
  const reload = useAtomRefresh(cloudVoiceKeysAtom(id));
  const canManage = useEnvironmentScope(id, AuthSettingsWriteScope);
  const [editing, setEditing] = useState<{
    provider: CloudSpeechProvider;
    enable: boolean;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(null);
  const sources =
    Constants.expoConfig?.extra?.secretsFeatureEnabled === true &&
    environment.serverConfig?.secretReferences
      ? configuredSecretSources(environment.serverConfig.settings.secretProviders)
      : [];
  const source = sources.find((candidate) => candidate.id === sourceId);
  const credential =
    sourceId !== null
      ? source && secretRequestReference(source, draft)
      : isApiKey(draft.trim())
        ? draft.trim()
        : undefined;
  const [saving, setSaving] = useState(false);
  const enable = (commit: () => void) => {
    try {
      commit();
    } catch {
      Dialog.alert(
        "Could not enable cloud dictation",
        "Check device storage and choose the provider again.",
      );
    }
  };
  const editKey = (provider: CloudSpeechProvider, enable: boolean) => {
    const stored = environment.serverConfig?.settings.cloudSpeechCredentials?.[provider];
    const ref =
      isSecretReference(stored) && sources.some((candidate) => candidate.id === stored.provider)
        ? stored
        : null;
    setSourceId(ref?.provider ?? null);
    setDraft(ref?.reference ?? "");
    setEditing({ provider, enable });
  };
  const changeKey = async (provider: CloudSpeechProvider, value: SettingsSecretValue | null) => {
    if (!connection || !canManage || saving) return;
    const commit = value !== null && editing?.enable ? pendingCloudVoiceChoice(id, provider) : null;
    setSaving(true);
    try {
      await runSpeech(setCloudSpeechKey(connection, provider, value));
    } catch {
      setSaving(false);
      Dialog.alert(
        "Could not update the API key",
        "Check the environment connection and your settings permissions.",
      );
      return;
    }
    setSaving(false);
    if (commit) enable(commit);
    setDraft("");
    setEditing(null);
    reload();
  };
  if (!AsyncResult.isSuccess(keys) || !keys.value || !connection)
    return (
      <ListActionRow
        label={
          !connection
            ? "Environment not connected"
            : keys._tag === "Failure"
              ? "Could not load keys · Retry"
              : "Checking API keys…"
        }
        disabled={!connection || keys._tag !== "Failure"}
        onPress={reload}
      />
    );
  return CloudSpeechProvider.literals.map((provider) => {
    const label = CLOUD_SPEECH_LABELS[provider];
    const company = CLOUD_SPEECH_PROVIDER_NAMES[provider];
    const disclosure = `After you stop recording, ${environment.label} sends your audio and vocabulary hints, including project names, to ${company}.`;
    const saved = keys.value![provider];
    return (
      <View key={provider}>
        <ListChoiceRow
          label={label}
          leading={<ProviderIcon provider={provider === "openai" ? "codex" : "grok"} size={20} />}
          selected={active === provider}
          disabled={(!saved && !canManage) || saving}
          description={
            active === provider && saved && canManage
              ? "Tap to manage key"
              : saved
                ? "API key saved on this environment"
                : canManage
                  ? "Add an API key to use this provider"
                  : "Ask an environment administrator to add an API key"
          }
          onPress={() => {
            if (!saved) return editKey(provider, true);
            if (active === provider) {
              if (canManage) editKey(provider, false);
              return;
            }
            Dialog.confirm({
              title: `Use ${label} for dictation?`,
              message: `${disclosure} Select This device to stop sharing.`,
              confirmText: `Use ${label}`,
              onConfirm: () => enable(pendingCloudVoiceChoice(id, provider)),
            });
          }}
        />
        {canManage && editing?.provider === provider && (
          <>
            {sources.length > 0 && (
              <View className="mx-4 flex-row flex-wrap gap-2">
                <Chip
                  label="Value"
                  size="small"
                  selected={sourceId === null}
                  disabled={saving}
                  onPress={() => {
                    setDraft("");
                    setSourceId(null);
                  }}
                />
                {sources.map((candidate) => (
                  <Chip
                    key={candidate.id}
                    label={candidate.label}
                    size="small"
                    selected={sourceId === candidate.id}
                    disabled={saving}
                    onPress={() => {
                      setDraft("");
                      setSourceId(candidate.id);
                    }}
                  />
                ))}
              </View>
            )}
            <TextInput
              key={sourceId ?? "literal"}
              accessibilityLabel={sourceId ? `${label} API key reference` : `${label} API key`}
              placeholder={source?.referencePlaceholder ?? "API key"}
              secureTextEntry={sourceId === null}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              importantForAutofill="no"
              maxLength={4096}
              editable={!saving}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (credential) void changeKey(provider, credential);
              }}
              value={draft}
              onChangeText={setDraft}
              className="mx-4 rounded-lg bg-background px-3 py-2 text-foreground"
            />
            <ListActionRow
              label={editing.enable ? "Save and enable" : "Save key"}
              description={
                draft && !credential
                  ? (source?.invalidReferenceMessage ?? "Enter a valid API key.")
                  : editing.enable
                    ? `${disclosure} Anyone with dictation access to ${environment.label} can bill this key.`
                    : `Updates the ${company} key on ${environment.label}. Your dictation destination stays the same.`
              }
              disabled={!credential || saving}
              onPress={() => {
                if (credential) void changeKey(provider, credential);
              }}
            />
            {saved && (
              <ListActionRow
                tone="danger"
                label="Remove key from environment"
                disabled={saving}
                onPress={() =>
                  Dialog.confirm({
                    title: `Remove the ${label} key from ${environment.label}?`,
                    message: "Everyone using it for dictation will lose access.",
                    confirmText: "Remove key",
                    destructive: true,
                    onConfirm: () => void changeKey(provider, null),
                  })
                }
              />
            )}
            <ListActionRow
              label="Cancel"
              disabled={saving}
              onPress={() => {
                setEditing(null);
                setDraft("");
              }}
            />
          </>
        )}
      </View>
    );
  });
}
