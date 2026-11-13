import { appAtomRegistry } from "../../state/atom-registry";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Speech from "expo-speech";
import { ScrollView, TextInput, View } from "react-native";
import {
  AuthSettingsWriteScope,
  DEFAULT_READ_ALOUD_SETTINGS,
  READ_ALOUD_LABELS,
  type ReadAloudSettings,
  type EnvironmentId,
  type SpeechSynthesisCatalog,
  type SpeechSynthesisProvider,
} from "@t3tools/contracts";
import { getSpeechSynthesisModels, setCloudSpeechKey } from "@t3tools/client-runtime/voice-input";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useEnvironments } from "../../state/environments";
import {
  useEnvironmentScope,
  usePreparedConnection,
  environmentSession,
} from "../../state/session";
import { AppText as Text } from "../../components/ui/AppText";
import { ListSection } from "../../components/ui/ListSection";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Sheet } from "../../components/ui/Sheet";
import { Button } from "../../components/ui/Button";
import { runSpeech } from "../voice-input/voiceDestination";
import { readAloudController } from "../read-aloud/playback";

export function ReadAloudSection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom);
  const settings = AsyncResult.isSuccess(preferences)
    ? (preferences.value.readAloud ?? DEFAULT_READ_ALOUD_SETTINGS)
    : DEFAULT_READ_ALOUD_SETTINGS;
  const prepared = Option.getOrNull(usePreparedConnection(settings.environmentId));
  const canManage = useEnvironmentScope(settings.environmentId, AuthSettingsWriteScope);
  const { environments, presentationById } = useEnvironments();

  const [subscriptionAvailability, setSubscriptionAvailability] = useState<{
    presentations: typeof presentationById;
    ids: ReadonlySet<EnvironmentId>;
  } | null>(null);
  const [sourceSubscriptions, setSourceSubscriptions] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(),
  );
  const availableSubscriptions =
    subscriptionAvailability?.presentations === presentationById
      ? subscriptionAvailability.ids
      : new Set<EnvironmentId>();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscription choices reflect native login availability on each paired environment.
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all(
      [...presentationById.keys()].map((environmentId) => {
        const connection = Option.getOrNull(
          appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
        );
        if (!connection) return null;
        return runSpeech(getSpeechSynthesisModels(connection, "chatgpt"), abort.signal).then(
          (catalog) => (catalog.models.length > 0 ? environmentId : null),
          () => null,
        );
      }),
    ).then((ids) => {
      if (!abort.signal.aborted)
        setSubscriptionAvailability({
          presentations: presentationById,
          ids: new Set(ids.filter((id) => id !== null)),
        });
    });
    return () => abort.abort();
  }, [presentationById]);

  const [sheet, setSheet] = useState<"source" | "model" | "voice" | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const catalogKey = JSON.stringify([settings.environmentId, settings.provider, catalogVersion]);
  const [catalogState, setCatalogState] = useState<{
    key: string;
    catalog: SpeechSynthesisCatalog;
    error: string;
  }>({ key: "", catalog: { models: [] }, error: "" });
  const catalog = catalogState.key === catalogKey ? catalogState.catalog : { models: [] };
  const catalogError = catalogState.key === catalogKey ? catalogState.error : "";
  const [voices, setVoices] = useState<Speech.Voice[]>([]);
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  const state = useSyncExternalStore(
    readAloudController.subscribe,
    readAloudController.getSnapshot,
  );
  const change = (patch: Partial<ReadAloudSettings>) => {
    readAloudController.stop();
    if (patch.provider || patch.environmentId) setKey("");
    update({ readAloud: { ...settings, ...patch } });
  };
  const cloud = settings.provider === "xai" || settings.provider === "openrouter";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read installed system voices from the native speech engine.
  useEffect(() => {
    let mounted = true;
    void Speech.getAvailableVoicesAsync().then(
      (value) => {
        if (mounted) setVoices(value);
      },
      () => {},
    );
    return () => {
      mounted = false;
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load models from the selected environment and cancel obsolete requests.
  useEffect(() => {
    if (!prepared || settings.provider === "system" || settings.provider === "off") return;
    const abort = new AbortController();
    void runSpeech(getSpeechSynthesisModels(prepared, settings.provider), abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setCatalogState({ key: catalogKey, catalog: value, error: "" });
      },
      () => {
        if (!abort.signal.aborted)
          setCatalogState({
            key: catalogKey,
            catalog: { models: [] },
            error:
              "Could not load speech models. Check the environment connection and speech server setup.",
          });
      },
    );
    return () => abort.abort();
  }, [prepared, settings.provider, catalogKey]);
  const selectedModel = catalog.models.find((entry) => entry.id === settings.model);
  const voiceChoices =
    settings.provider === "system"
      ? voices.map((voice) => ({ id: voice.identifier, name: voice.name }))
      : (selectedModel?.voices ?? []).map((voice) => ({ id: voice, name: voice }));
  return (
    <>
      <ListSection
        title="Read aloud"
        footer={
          settings.provider === "chatgpt"
            ? undefined
            : "Hosted providers receive the response text through your selected environment. Grok and OpenRouter use API billing and share keys with dictation. Playback stops when you leave the thread."
        }
      >
        <ListActionRow
          label="Speech provider"
          detail={READ_ALOUD_LABELS[settings.provider]}
          onPress={() => {
            setSourceSubscriptions(availableSubscriptions);
            setSheet("source");
          }}
        />
        {settings.provider !== "off" && (
          <>
            {settings.provider !== "system" && settings.provider !== "chatgpt" && (
              <ListActionRow
                label="Speech model"
                detail={selectedModel?.name || settings.model || "Choose a model"}
                onPress={() => setSheet("model")}
              />
            )}
            {settings.provider !== "chatgpt" && (
              <ListActionRow
                label="Voice"
                detail={
                  voiceChoices.find((voice) => voice.id === settings.voice)?.name ||
                  settings.voice ||
                  "Default"
                }
                onPress={() => setSheet("voice")}
              />
            )}
            <ListActionRow
              label="Speed"
              detail={`${settings.speed}×`}
              onPress={() =>
                change({ speed: settings.speed >= 1.5 ? 0.75 : settings.speed + 0.25 })
              }
            />
            <ListToggleRow
              label="Background playback"
              value={settings.backgroundPlayback}
              onValueChange={(backgroundPlayback) => change({ backgroundPlayback })}
            />
            <ListToggleRow
              label="Skip code blocks"
              value={settings.skipCodeBlocks}
              onValueChange={(skipCodeBlocks) => change({ skipCodeBlocks })}
            />
            <ListActionRow
              label={
                state.id === "preview" && state.status !== "error" ? "Stop preview" : "Play preview"
              }
              onPress={() =>
                state.id === "preview" && state.status !== "error"
                  ? readAloudController.stop()
                  : void readAloudController.start(
                      "preview",
                      "This is T3 Code. Your agent's response is ready to read aloud.",
                      settings,
                    )
              }
            />
          </>
        )}
      </ListSection>
      {cloud && prepared && canManage && (
        <ListSection
          title="Speech API key"
          footer="Leave this empty to keep using the key already saved for dictation."
        >
          <View className="gap-3 p-4">
            <TextInput
              accessibilityLabel="Read-aloud API key"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              className="rounded-lg border border-border-subtle px-3 py-2 text-foreground"
              value={key}
              onChangeText={setKey}
            />
            <Button
              label="Save key"
              size="compact"
              disabled={!key.trim()}
              onPress={() => {
                if (
                  settings.provider === "system" ||
                  settings.provider === "off" ||
                  settings.provider === "chatgpt"
                )
                  return;
                void runSpeech(setCloudSpeechKey(prepared, settings.provider, key.trim())).then(
                  () => {
                    setKey("");
                    setCatalogVersion((value) => value + 1);
                  },
                  () => setError("Could not save the API key."),
                );
              }}
            />
            <Button
              label="Remove shared API key"
              size="compact"
              onPress={() => {
                if (!cloud) return;
                void runSpeech(setCloudSpeechKey(prepared, settings.provider, null)).then(
                  () => {
                    setKey("");
                    setCatalogVersion((value) => value + 1);
                  },
                  () => setError("Could not remove the API key."),
                );
              }}
            />
          </View>
        </ListSection>
      )}
      {(error || catalogError || state.error) && (
        <Text accessibilityRole="alert" className="text-sm text-danger">
          {error || catalogError || state.error}
        </Text>
      )}
      {sheet && (
        <Sheet
          title={
            sheet === "source" ? "Speech provider" : sheet === "model" ? "Speech model" : "Voice"
          }
          onClose={() => setSheet(null)}
        >
          <ScrollView contentContainerClassName="gap-3 px-5 pb-8">
            {sheet === "source" ? (
              <>
                <ListSection>
                  {(["off", "system"] as const).map((provider) => (
                    <ListChoiceRow
                      key={provider}
                      label={READ_ALOUD_LABELS[provider]}
                      selected={settings.provider === provider}
                      onPress={() => {
                        change({ provider, model: "", voice: "", environmentId: null });
                        setSheet(null);
                      }}
                    />
                  ))}
                </ListSection>
                {environments.map((environment) => (
                  <ListSection key={environment.environmentId} title={`Via ${environment.label}`}>
                    {(["chatgpt", "xai", "openrouter"] as const)
                      .filter(
                        (provider) =>
                          provider !== "chatgpt" ||
                          sourceSubscriptions.has(environment.environmentId),
                      )
                      .map((provider) => (
                        <ListChoiceRow
                          key={provider}
                          label={READ_ALOUD_LABELS[provider]}
                          selected={
                            settings.provider === provider &&
                            settings.environmentId === environment.environmentId
                          }
                          onPress={() => {
                            change({
                              provider: provider as SpeechSynthesisProvider,
                              environmentId: environment.environmentId,
                              model:
                                provider === "xai"
                                  ? "grok-tts"
                                  : provider === "chatgpt"
                                    ? "chatgpt-read-aloud"
                                    : "",
                              voice: "",
                            });
                            setSheet(null);
                          }}
                        />
                      ))}
                  </ListSection>
                ))}
              </>
            ) : sheet === "model" ? (
              <ListSection>
                {catalog.models.map((model) => (
                  <ListChoiceRow
                    key={model.id}
                    label={model.name}
                    selected={settings.model === model.id}
                    onPress={() => {
                      change({ model: model.id, voice: "" });
                      setSheet(null);
                    }}
                  />
                ))}
              </ListSection>
            ) : (
              <ListSection>
                {voiceChoices.length === 0 && (
                  <View className="p-4">
                    <TextInput
                      accessibilityLabel="Read-aloud voice"
                      placeholder="Default voice"
                      value={settings.voice}
                      onChangeText={(voice) => change({ voice })}
                      autoCapitalize="none"
                      autoCorrect={false}
                      className="rounded-lg border border-border-subtle px-3 py-2 text-foreground"
                    />
                  </View>
                )}
                <ListChoiceRow
                  label="Default"
                  selected={!settings.voice}
                  onPress={() => {
                    change({ voice: "" });
                    setSheet(null);
                  }}
                />
                {voiceChoices.map((voice) => (
                  <ListChoiceRow
                    key={voice.id}
                    label={voice.name}
                    selected={settings.voice === voice.id}
                    onPress={() => {
                      change({ voice: voice.id });
                      setSheet(null);
                    }}
                  />
                ))}
              </ListSection>
            )}
          </ScrollView>
        </Sheet>
      )}
    </>
  );
}
