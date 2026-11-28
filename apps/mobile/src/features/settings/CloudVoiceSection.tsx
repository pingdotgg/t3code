import { T, useGT, useMessages } from "gt-react-native";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { cloudSpeechDisclosure } from "@t3tools/shared/speechCopy";
import { setCloudSpeechKey } from "@t3tools/client-runtime/voice-input";
import { OpenRouterSignIn } from "./OpenRouterSignIn";
import { CatalogPicker } from "./CatalogPicker";
import { hasFeatureFlag } from "@t3tools/client-runtime/state/server";
import {
  configuredSecretSources,
  secretRequestReference,
} from "@t3tools/client-runtime/secret-request";
import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  CLOUD_SPEECH_LABELS,
  CLOUD_SPEECH_PROVIDER_NAMES,
  CloudSpeechProvider,
  CloudSpeechApiKey,
  DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL,
  type CloudSpeechModelId,
  isSecretReference,
  type CloudSpeechModel,
  type SecretProviderId,
  type SettingsSecretValue,
  type VoiceTranscriptionDestination,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { Sheet } from "../../components/ui/Sheet";
import * as Dialog from "../../components/ui/Dialog";
import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { Chip } from "../../components/ui/Chip";
import { ListSection } from "../../components/ui/ListSection";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import {
  chooseVoiceDestination,
  pendingCloudVoiceChoice,
  cloudVoiceConnectionAtom,
  cloudVoiceKeysAtom,
  cloudVoiceModelsAtom,
  runSpeech,
} from "../voice-input/voiceDestination";

type CloudDestination = Extract<VoiceTranscriptionDestination, { kind: "cloud" }>;
type Props = { environment: EnvironmentPresentation; active: CloudDestination | null };
const isApiKey = Schema.is(CloudSpeechApiKey);

/** The cloud method row for one environment; opens the provider sheet. */
export function CloudVoiceChoice({
  environment,
  active,
  open,
  onOpenChange,
}: Props & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const gt = useGT();
  const usable = useAtomValue(cloudVoiceConnectionAtom(environment.environmentId)) !== null;
  return (
    <>
      <ListChoiceRow
        label={gt("Cloud provider")}
        description={
          active
            ? `${CLOUD_SPEECH_LABELS[active.provider]}${active.provider === "openrouter" ? ` · ${active.model}` : ""}`
            : usable
              ? gt("Use your own API key")
              : gt("Not connected")
        }
        selected={active !== null}
        disabled={!usable}
        separated
        onPress={() => onOpenChange(true)}
      />
      {open && (
        <CloudChoices
          environment={environment}
          active={active}
          onClose={() => onOpenChange(false)}
        />
      )}
    </>
  );
}

function ModelPicker({
  models,
  value,
  current,
  disabled,
  onChange,
}: {
  models: ReadonlyArray<CloudSpeechModel>;
  value: string;
  /** The grant's model, flagged when the catalog no longer lists it. */
  current: string | undefined;
  disabled: boolean;
  onChange: (model: CloudSpeechModelId) => void;
}) {
  const gt = useGT();
  const delisted = current !== undefined && !models.some((model) => model.id === current);
  return (
    <CatalogPicker
      items={models}
      value={value}
      disabled={disabled}
      onChange={(model) => onChange(model.id)}
      title={gt("Model")}
      footer={
        delisted
          ? gt(
              "{provider} no longer lists {model}. Dictation stays off until you choose another model.",
              { provider: "OpenRouter", model: current },
            )
          : undefined
      }
      searchLabel={gt("Search {provider} models", { provider: "OpenRouter" })}
      placeholder={gt("Search transcription models")}
      empty={<T>No transcription model matches.</T>}
      showAllLabel={(count) =>
        gt("{count, plural, one {Show all {count} models} other {Show all {count} models}}", {
          count,
        })
      }
    />
  );
}

/** A hairline above a row that has no `separated` prop of its own. */
function Separated({ children }: { children: ReactNode }) {
  return <View className="border-t border-border-subtle">{children}</View>;
}

function CloudChoices({ environment, active, onClose }: Props & { onClose: () => void }) {
  const gt = useGT();
  const messages = useMessages();
  const id = environment.environmentId;
  const connection = useAtomValue(cloudVoiceConnectionAtom(id));
  const keys = useAtomValue(cloudVoiceKeysAtom(id));
  const reload = useAtomRefresh(cloudVoiceKeysAtom(id));
  const canManage = useEnvironmentScope(id, AuthSettingsWriteScope);
  const canUseReferences = useEnvironmentScope(id, AuthProvidersManageScope);
  const [editing, setEditing] = useState<{
    provider: CloudSpeechProvider;
    enable: boolean;
  } | null>(null);
  const catalogAtom = cloudVoiceModelsAtom(active?.provider === "openrouter" ? id : null);
  const models = useAtomValue(catalogAtom);
  const reloadModels = useAtomRefresh(catalogAtom);
  const [draft, setDraft] = useState("");
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(null);
  const sources =
    canUseReferences &&
    hasFeatureFlag(environment.serverConfig, "secretProviders") &&
    environment.serverConfig?.secretReferences
      ? configuredSecretSources(environment.serverConfig.settings.secretProviders, messages)
      : [];
  const source = sources.find((candidate) => candidate.id === sourceId);
  const credential =
    sourceId !== null
      ? source && secretRequestReference(source, draft)
      : isApiKey(draft.trim())
        ? draft.trim()
        : undefined;
  const [saving, setSaving] = useState(false);
  const activeModel = active?.provider === "openrouter" ? active.model : undefined;
  // The model is chosen on this page once OpenRouter is set up; it starts at the default.
  const routedModel = activeModel ?? DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL;
  const enable = (commit: () => void) => {
    try {
      commit();
    } catch {
      Dialog.alert(
        gt("Could not enable cloud dictation"),
        gt("Check device storage and choose the provider again."),
      );
    }
  };
  const edit = (provider: CloudSpeechProvider, enable: boolean) => {
    const stored = environment.serverConfig?.settings.cloudSpeechCredentials?.[provider];
    const ref =
      isSecretReference(stored) && sources.some((candidate) => candidate.id === stored.provider)
        ? stored
        : null;
    setSourceId(ref?.provider ?? null);
    setDraft(ref?.reference ?? "");
    setEditing({ provider, enable });
  };
  const reset = () => {
    setDraft("");
    setEditing(null);
  };
  const changeKey = async (
    provider: CloudSpeechProvider,
    value: SettingsSecretValue | null,
    chosen?: CloudSpeechModelId,
  ) => {
    if (!connection || !canManage || saving) return;
    const commit =
      value !== null && (editing?.enable || (chosen !== undefined && chosen !== activeModel))
        ? pendingCloudVoiceChoice(id, provider, chosen)
        : null;
    setSaving(true);
    try {
      await runSpeech(setCloudSpeechKey(connection, provider, value));
    } catch {
      setSaving(false);
      Dialog.alert(
        gt("Could not update the API key"),
        gt("Check the environment connection and your settings permissions."),
      );
      return;
    }
    setSaving(false);
    if (commit) enable(commit);
    reload();
    onClose();
  };
  const catalog = AsyncResult.isSuccess(models) ? (models.value?.models ?? null) : null;
  const content = (() => {
    if (!AsyncResult.isSuccess(keys) || !keys.value || !connection)
      return (
        <ListSection>
          <ListActionRow
            label={
              !connection
                ? gt("Environment not connected")
                : keys._tag === "Failure"
                  ? gt("Could not load keys · Retry")
                  : gt("Checking API keys…")
            }
            disabled={!connection || keys._tag !== "Failure"}
            onPress={reload}
          />
        </ListSection>
      );
    const saved = keys.value;
    if (!editing)
      return (
        <>
          <ListSection
            footer={gt("Audio is sent through {environment} using its API key.", {
              environment: environment.label,
            })}
          >
            {CloudSpeechProvider.literals.map((provider, index) => {
              const label = CLOUD_SPEECH_LABELS[provider];
              const routed = provider === "openrouter";
              const key = saved[provider];
              const isActive = active?.provider === provider;
              return (
                <ListChoiceRow
                  key={provider}
                  label={label}
                  leading={
                    <ProviderIcon
                      provider={
                        provider === "openai" ? "codex" : provider === "xai" ? "grok" : provider
                      }
                      size={20}
                    />
                  }
                  selected={isActive}
                  separated={index > 0}
                  disabled={key === undefined || (!key && !canManage) || saving}
                  description={
                    key === undefined
                      ? gt("Update the environment to use this provider")
                      : isActive && key && canManage
                        ? gt("Tap to manage key")
                        : key
                          ? gt("API key saved")
                          : canManage
                            ? gt("Add an API key to use this provider")
                            : gt("Ask an environment administrator to add an API key")
                  }
                  onPress={() => {
                    if (!key) return edit(provider, true);
                    if (isActive) {
                      if (canManage) edit(provider, false);
                      return;
                    }
                    Dialog.confirm({
                      title: gt("Use {provider} for dictation?", { provider: label }),
                      message: gt("{disclosure} Select This device to stop sharing.", {
                        disclosure: cloudSpeechDisclosure(provider, environment.label, messages),
                      }),
                      confirmText: gt("Use {provider}", { provider: label }),
                      onConfirm: () =>
                        enable(
                          pendingCloudVoiceChoice(id, provider, routed ? routedModel : undefined),
                        ),
                    });
                  }}
                />
              );
            })}
          </ListSection>
          {active?.provider === "openrouter" &&
            (catalog ? (
              <ModelPicker
                models={catalog}
                value={routedModel}
                current={activeModel}
                disabled={saving}
                onChange={(next) => {
                  if (next !== activeModel)
                    enable(() => chooseVoiceDestination(id, "openrouter", next));
                }}
              />
            ) : (
              <ListSection title={gt("Model")}>
                <ListActionRow
                  label={
                    AsyncResult.isFailure(models)
                      ? gt("Could not load models · Retry")
                      : gt("Loading transcription models…")
                  }
                  disabled={!AsyncResult.isFailure(models)}
                  onPress={reloadModels}
                />
              </ListSection>
            ))}
        </>
      );

    const provider = editing.provider;
    const label = CLOUD_SPEECH_LABELS[provider];
    const company = CLOUD_SPEECH_PROVIDER_NAMES[provider];
    const routed = provider === "openrouter";
    const disclosure = cloudSpeechDisclosure(provider, environment.label, messages);
    const key = saved[provider];
    const isActive = active?.provider === provider;
    const original = environment.serverConfig?.settings.cloudSpeechCredentials?.[provider];
    const keyChanged =
      credential !== undefined &&
      !(
        isSecretReference(credential) &&
        isSecretReference(original) &&
        original.provider === credential.provider &&
        original.reference === credential.reference
      );
    const routedReady =
      (draft.trim() ? credential !== undefined : Boolean(key)) && (!isActive || keyChanged);
    const saveRouted = () => {
      if (!routedReady) return;
      if (credential !== undefined && keyChanged)
        return void changeKey(provider, credential, routedModel);
      if (!isActive) enable(() => chooseVoiceDestination(id, provider, routedModel));
      onClose();
    };
    const submit = () => {
      if (routed) saveRouted();
      else if (credential) void changeKey(provider, credential);
    };
    const keyFooter =
      draft && !credential
        ? (source?.invalidReferenceMessage ?? gt("Enter a valid API key."))
        : routed
          ? key && !credential
            ? gt(
                "Uses the API key saved on this environment. The model choice applies only to this device.",
              )
            : undefined
          : editing.enable
            ? undefined
            : gt(
                "Updates the {company} key on {environment}. Your dictation destination stays the same.",
                { company, environment: environment.label },
              );
    return (
      <>
        <Text className="px-2 text-sm text-foreground-muted">{disclosure}</Text>
        {canManage ? (
          <ListSection title={gt("API key")} footer={keyFooter}>
            <View className="gap-3 px-4 py-3">
              {routed && connection && (
                <OpenRouterSignIn
                  prepared={connection}
                  onSignedIn={() => {
                    reload();
                    if (editing.enable)
                      enable(pendingCloudVoiceChoice(id, "openrouter", routedModel));
                    onClose();
                  }}
                />
              )}
              {sources.length > 0 && (
                <View className="flex-row flex-wrap gap-2">
                  <Chip
                    label={gt("Value", { $context: "enter the secret value directly" })}
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
                accessibilityLabel={
                  sourceId
                    ? gt("{provider} API key reference", { provider: label })
                    : gt("{provider} API key", { provider: label })
                }
                placeholder={
                  source?.referencePlaceholder ??
                  (key ? gt("Saved key · enter a new one to replace") : gt("API key"))
                }
                secureTextEntry={sourceId === null}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                textContentType="none"
                importantForAutofill="no"
                maxLength={4096}
                editable={!saving}
                returnKeyType="done"
                onSubmitEditing={submit}
                value={draft}
                onChangeText={setDraft}
                className="rounded-lg bg-background px-3 py-2 text-foreground"
              />
            </View>
          </ListSection>
        ) : null}
        {canManage || routed ? (
          <ListSection>
            {routed && !key && !canManage ? (
              <ListActionRow
                label={gt("Ask an administrator to add an {provider} key", {
                  provider: "OpenRouter",
                })}
                disabled
                onPress={() => {}}
              />
            ) : (
              <ListActionRow
                label={
                  routed
                    ? isActive
                      ? gt("Save")
                      : gt("Save and enable")
                    : editing.enable
                      ? gt("Save and enable")
                      : gt("Save key")
                }
                loading={saving}
                disabled={routed ? !routedReady : !credential}
                onPress={submit}
              />
            )}
            {key && canManage ? (
              <Separated>
                <ListActionRow
                  tone="danger"
                  label={gt("Remove key from environment")}
                  disabled={saving}
                  onPress={() =>
                    Dialog.confirm({
                      title: gt("Remove the {provider} key from {environment}?", {
                        provider: label,
                        environment: environment.label,
                      }),
                      message: gt("Everyone using it for dictation will lose access."),
                      confirmText: gt("Remove key"),
                      destructive: true,
                      onConfirm: () => void changeKey(provider, null),
                    })
                  }
                />
              </Separated>
            ) : null}
          </ListSection>
        ) : null}
        <ListSection>
          <ListActionRow label={gt("Back to providers")} disabled={saving} onPress={reset} />
        </ListSection>
      </>
    );
  })();
  return (
    <Sheet
      title={editing ? CLOUD_SPEECH_LABELS[editing.provider] : gt("Cloud providers")}
      onClose={onClose}
      dismissDisabled={saving}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-5 pt-2 pb-8"
      >
        {content}
      </ScrollView>
    </Sheet>
  );
}
