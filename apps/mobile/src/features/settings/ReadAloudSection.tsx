import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Speech from "expo-speech";
import { T, useGT } from "gt-react-native";
import { ScrollView, TextInput, View } from "react-native";
import {
  AuthSettingsWriteScope,
  CloudSpeechSynthesisProvider,
  DEFAULT_READ_ALOUD_SETTINGS,
  READ_ALOUD_LABELS,
  EMPTY_SPEECH_SYNTHESIS_CATALOG,
  type ReadAloudSettings,
  type SpeechSynthesisCatalog,
  WORD_TIMING_MODEL_ID,
} from "@t3tools/contracts";
import {
  cancelSpeechSynthesisModelDownload,
  downloadSpeechSynthesisModel,
  getSpeechSynthesisModels,
  removeSpeechSynthesisModel,
  setCloudSpeechKey,
} from "@t3tools/client-runtime/voice-input";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { AppText as Text } from "../../components/ui/AppText";
import { ListSection } from "../../components/ui/ListSection";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Sheet } from "../../components/ui/Sheet";
import { Button } from "../../components/ui/Button";
import { OpenRouterSignIn } from "./OpenRouterSignIn";
import { CatalogPicker } from "./CatalogPicker";
import { runSpeech } from "../voice-input/voiceDestination";
import { readAloudController } from "../read-aloud/playback";

export function ReadAloudSection() {
  const gt = useGT();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const settings = AsyncResult.isSuccess(preferences)
    ? (preferences.value.readAloud ?? DEFAULT_READ_ALOUD_SETTINGS)
    : DEFAULT_READ_ALOUD_SETTINGS;
  const prepared = Option.getOrNull(usePreparedConnection(settings.environmentId));
  const canManage = useEnvironmentScope(settings.environmentId, AuthSettingsWriteScope);
  const { environments } = useEnvironments();

  const [sheet, setSheet] = useState<"source" | "model" | "voice" | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The preview belongs to this screen, so leaving it stops the sample.
  useEffect(
    () => () => {
      if (readAloudController.getSnapshot().id === "preview") readAloudController.stop();
    },
    [],
  );
  const [catalogVersion, setCatalogVersion] = useState(0);
  const catalogKey = JSON.stringify([settings.environmentId, settings.provider]);
  const [catalogState, setCatalogState] = useState<{
    key: string;
    version: number;
    catalog: SpeechSynthesisCatalog;
    failed: boolean;
  }>({ key: "", version: -1, catalog: EMPTY_SPEECH_SYNTHESIS_CATALOG, failed: false });
  const catalog =
    catalogState.key === catalogKey ? catalogState.catalog : EMPTY_SPEECH_SYNTHESIS_CATALOG;
  const catalogError =
    catalogState.key === catalogKey && catalogState.version === catalogVersion
      ? catalogState.failed
        ? gt(
            "Could not load speech models. Check the environment connection and speech server setup.",
          )
        : catalog.error || ""
      : "";
  const model = settings.model || catalog.defaultModel;
  const [voices, setVoices] = useState<Speech.Voice[]>([]);
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  const keyRequestVersion = useRef(0);
  const state = useSyncExternalStore(
    readAloudController.subscribe,
    readAloudController.getSnapshot,
  );
  const change = (patch: Partial<ReadAloudSettings>) => {
    readAloudController.stop();
    if (patch.provider !== undefined || patch.environmentId !== undefined) {
      keyRequestVersion.current++;
      setKey("");
      setError("");
    }
    void savePreferences({ readAloud: { ...settings, ...patch } });
  };
  const cloud = catalog.apiKeyProvider !== null;
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load models and invalidate speech requests when their environment or provider changes.
  useEffect(() => {
    if (!prepared || settings.provider === "system" || settings.provider === "off") return;
    const abort = new AbortController();
    void runSpeech(getSpeechSynthesisModels(prepared, settings.provider), abort.signal).then(
      (value) => {
        if (!abort.signal.aborted)
          setCatalogState({
            key: catalogKey,
            version: catalogVersion,
            catalog: value,
            failed: false,
          });
      },
      () => {
        if (!abort.signal.aborted)
          setCatalogState({
            key: catalogKey,
            version: catalogVersion,
            catalog: EMPTY_SPEECH_SYNTHESIS_CATALOG,
            failed: true,
          });
      },
    );
    return () => {
      abort.abort();
      keyRequestVersion.current++;
    };
  }, [prepared, settings.provider, catalogKey, catalogVersion]);
  const selectedModel = catalog.models.find((entry) => entry.id === model);
  const install = settings.provider === "local" ? selectedModel?.install : undefined;
  // Keyed by environment and model, so switching models mid-download doesn't move the spinner.
  const installKey = JSON.stringify([settings.environmentId, selectedModel?.id]);
  const [installing, setInstalling] = useState<string | null>(null);
  const downloading =
    installing === installKey || install?.state === "downloading" || install?.state === "verifying";
  const wordTiming = catalog.wordTimingModel;
  const wordTimingKey = JSON.stringify([settings.environmentId, WORD_TIMING_MODEL_ID]);
  const timingDownloading =
    installing === wordTimingKey ||
    wordTiming?.state === "downloading" ||
    wordTiming?.state === "verifying";
  // Waits for the catalog request in flight; refreshing again would abort it.
  const refreshing = catalogState.version !== catalogVersion;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Poll the environment's download progress while it runs.
  useEffect(() => {
    if ((!downloading && !timingDownloading) || refreshing) return;
    const timer = setTimeout(() => setCatalogVersion((value) => value + 1), 1_000);
    return () => clearTimeout(timer);
  }, [downloading, timingDownloading, refreshing]);
  const selectedTarget = selectedModel ? { id: selectedModel.id, key: installKey } : undefined;
  const changeInstall = (action: "download" | "cancel" | "remove", target = selectedTarget) => {
    if (!prepared || !target) return;
    const requestKey = target.key;
    if (action === "download") setInstalling(requestKey);
    setError("");
    void runSpeech(
      action === "download"
        ? downloadSpeechSynthesisModel(prepared, target.id)
        : action === "cancel"
          ? cancelSpeechSynthesisModelDownload(prepared, target.id)
          : removeSpeechSynthesisModel(prepared, target.id),
    )
      .then(
        () => {},
        () =>
          setError(
            action === "download"
              ? gt(
                  "Could not download the model. Check the environment’s connection and disk space.",
                )
              : gt("Could not change the model. Try again."),
          ),
      )
      .finally(() => {
        if (action === "download")
          setInstalling((current) => (current === requestKey ? null : current));
        setCatalogVersion((value) => value + 1);
      });
  };
  const installProgress =
    install?.downloaded === undefined ? 0 : Math.round((install.downloaded / install.size) * 100);
  const voiceChoices =
    settings.provider === "system"
      ? voices.map((voice) => ({ id: voice.identifier, name: voice.name }))
      : (selectedModel?.voices ?? []).map((voice) => ({
          id: voice,
          name: selectedModel?.voiceNames?.[voice] ?? voice,
        }));
  const providerEnvironment = environments.find(
    (environment) => environment.environmentId === settings.environmentId,
  );
  return (
    <>
      <ListSection
        title={gt("Read aloud")}
        footer={gt(
          "Hosted providers receive response text through your selected environment, use API billing, and share keys with dictation. A local model runs on that environment. Playback stops when you leave the thread.",
        )}
      >
        <ListActionRow
          label={gt("Speech provider")}
          detail={
            settings.provider === "local"
              ? (providerEnvironment?.label ?? gt("Unavailable environment"))
              : settings.provider === "off"
                ? gt("Off", { $context: "read aloud disabled" })
                : settings.provider === "system"
                  ? gt("System voices")
                  : gt("{provider} via {environment}", {
                      provider: READ_ALOUD_LABELS[settings.provider],
                      environment: providerEnvironment?.label ?? gt("unavailable environment"),
                    })
          }
          onPress={() => {
            setSheet("source");
          }}
        />
        {settings.provider !== "off" && (
          <>
            {settings.provider !== "system" &&
              catalog.supportsModelSelection &&
              catalog.models.length > 0 && (
                <ListActionRow
                  label={gt("Model", { $context: "text-to-speech model setting" })}
                  detail={selectedModel?.name || model || gt("Choose a model")}
                  onPress={() => setSheet("model")}
                />
              )}
            {(settings.provider === "system" ||
              (catalog.supportsVoiceSelection && catalog.models.length > 0)) && (
              <ListActionRow
                label={gt("Voice", { $context: "the speaker voice used to read text aloud" })}
                detail={
                  voiceChoices.find((voice) => voice.id === settings.voice)?.name ||
                  settings.voice ||
                  gt("Default", { $context: "default voice" })
                }
                onPress={() => setSheet("voice")}
              />
            )}
            <ListActionRow
              label={gt("Speed")}
              detail={gt("{speed}×", { speed: settings.speed })}
              onPress={() =>
                change({ speed: settings.speed >= 1.5 ? 0.75 : settings.speed + 0.25 })
              }
            />
            <ListToggleRow
              label={gt("Background playback")}
              value={settings.backgroundPlayback}
              onValueChange={(backgroundPlayback) => change({ backgroundPlayback })}
            />
            <ListToggleRow
              label={gt("Skip code blocks")}
              value={settings.skipCodeBlocks}
              onValueChange={(skipCodeBlocks) => change({ skipCodeBlocks })}
            />
            <ListActionRow
              label={
                state.id === "preview" && state.status !== "error"
                  ? gt("Stop preview")
                  : gt("Play preview")
              }
              onPress={() =>
                state.id === "preview" && state.status !== "error"
                  ? readAloudController.stop()
                  : void readAloudController.start(
                      "preview",
                      gt("This is T3 Code. Your agent’s response is ready to read aloud."),
                      settings,
                    )
              }
            />
          </>
        )}
      </ListSection>
      {install && prepared && selectedModel && (
        <ListSection
          title={gt("Local model")}
          footer={gt("Runs on the selected environment, so replies are read without leaving it.")}
        >
          {downloading ? (
            <ListActionRow
              label={gt("Cancel {name} download", { name: selectedModel.name })}
              detail={
                install.state === "verifying"
                  ? gt("Verifying…")
                  : gt("{percent}% downloaded", { percent: installProgress })
              }
              disabled={!canManage}
              onPress={() => changeInstall("cancel")}
            />
          ) : install.state === "installed" ? (
            <ListActionRow
              label={gt("Remove {name}", { name: selectedModel.name })}
              detail={gt("Installed")}
              tone="danger"
              disabled={!canManage}
              onPress={() => changeInstall("remove")}
            />
          ) : (
            <ListActionRow
              label={gt("Download {name}", { name: selectedModel.name })}
              detail={gt("{size} MB", { size: Math.round(install.size / 1024 / 1024) })}
              disabled={!canManage}
              onPress={() => changeInstall("download")}
            />
          )}
        </ListSection>
      )}
      {wordTiming && prepared && settings.provider !== "off" && (
        <ListSection
          title={gt("Word timing")}
          footer={gt(
            "Follows each spoken word exactly and starts reading right at the word you pick. Without it, the highlight is estimated. The model is for non-commercial use only.",
          )}
        >
          {timingDownloading ? (
            <ListActionRow
              label={gt("Cancel word timing download")}
              detail={
                wordTiming.state === "verifying"
                  ? gt("Verifying…")
                  : gt("{percent}% downloaded", {
                      percent:
                        wordTiming.downloaded === undefined
                          ? 0
                          : Math.round((wordTiming.downloaded / wordTiming.size) * 100),
                    })
              }
              disabled={!canManage}
              onPress={() =>
                changeInstall("cancel", { id: WORD_TIMING_MODEL_ID, key: wordTimingKey })
              }
            />
          ) : wordTiming.state === "installed" ? (
            <ListActionRow
              label={gt("Delete the word timing model")}
              detail={gt("Installed")}
              tone="danger"
              disabled={!canManage}
              onPress={() =>
                changeInstall("remove", { id: WORD_TIMING_MODEL_ID, key: wordTimingKey })
              }
            />
          ) : (
            <ListActionRow
              label={gt("Download the word timing model")}
              detail={gt("{size} MB", { size: Math.round(wordTiming.size / 1024 / 1024) })}
              disabled={!canManage}
              onPress={() =>
                changeInstall("download", { id: WORD_TIMING_MODEL_ID, key: wordTimingKey })
              }
            />
          )}
        </ListSection>
      )}
      {cloud && prepared && canManage && (
        <ListSection
          title={gt("Speech API key")}
          footer={gt("Leave this empty to keep using the key already saved for dictation.")}
        >
          <View className="gap-3 p-4">
            {catalog.apiKeyProvider === "openrouter" && (
              <OpenRouterSignIn
                prepared={prepared}
                onSignedIn={() => setCatalogVersion((value) => value + 1)}
              />
            )}
            <TextInput
              accessibilityLabel={gt("Read-aloud API key")}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              importantForAutofill="no"
              className="rounded-lg border border-border-subtle px-3 py-2 text-foreground"
              value={key}
              onChangeText={setKey}
            />
            <Button
              label={gt("Save key")}
              size="compact"
              disabled={!key.trim()}
              onPress={() => {
                if (!catalog.apiKeyProvider) return;
                const requestVersion = ++keyRequestVersion.current;
                setError("");
                void runSpeech(
                  setCloudSpeechKey(prepared, catalog.apiKeyProvider, key.trim()),
                ).then(
                  () => {
                    if (requestVersion !== keyRequestVersion.current) return;
                    setError("");
                    setKey("");
                    setCatalogVersion((value) => value + 1);
                  },
                  () => {
                    if (requestVersion === keyRequestVersion.current)
                      setError(gt("Could not save the API key."));
                  },
                );
              }}
            />
            <Button
              label={gt("Remove shared API key")}
              size="compact"
              onPress={() => {
                if (!catalog.apiKeyProvider) return;
                const requestVersion = ++keyRequestVersion.current;
                setError("");
                void runSpeech(setCloudSpeechKey(prepared, catalog.apiKeyProvider, null)).then(
                  () => {
                    if (requestVersion !== keyRequestVersion.current) return;
                    setError("");
                    setKey("");
                    setCatalogVersion((value) => value + 1);
                  },
                  () => {
                    if (requestVersion === keyRequestVersion.current)
                      setError(gt("Could not remove the API key."));
                  },
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
            sheet === "source"
              ? gt("Speech provider")
              : sheet === "model"
                ? gt("Model", { $context: "text-to-speech model setting" })
                : gt("Voice", { $context: "the speaker voice used to read text aloud" })
          }
          onClose={() => setSheet(null)}
        >
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerClassName="gap-3 px-5 pt-2 pb-8"
          >
            {sheet === "source" ? (
              <>
                <ListSection>
                  {(["off", "system"] as const).map((provider) => (
                    <ListChoiceRow
                      key={provider}
                      label={
                        provider === "off"
                          ? gt("Off", { $context: "read aloud disabled" })
                          : gt("System voices")
                      }
                      selected={settings.provider === provider}
                      onPress={() => {
                        change({ provider, model: "", voice: "", environmentId: null });
                        setSheet(null);
                      }}
                    />
                  ))}
                </ListSection>
                {environments.length > 0 && (
                  <ListSection title={gt("On an environment")}>
                    {environments.map((environment) => (
                      <ListChoiceRow
                        key={environment.environmentId}
                        label={environment.label}
                        selected={
                          settings.provider === "local" &&
                          settings.environmentId === environment.environmentId
                        }
                        onPress={() => {
                          change({
                            provider: "local",
                            environmentId: environment.environmentId,
                            model: "",
                            voice: "",
                          });
                          setSheet(null);
                        }}
                      />
                    ))}
                  </ListSection>
                )}
                {environments.map((environment) => (
                  <ListSection
                    key={environment.environmentId}
                    title={gt("Cloud via {environment}", { environment: environment.label })}
                  >
                    {CloudSpeechSynthesisProvider.literals.map((provider) => (
                      <ListChoiceRow
                        key={provider}
                        label={READ_ALOUD_LABELS[provider]}
                        selected={
                          settings.provider === provider &&
                          settings.environmentId === environment.environmentId
                        }
                        onPress={() => {
                          change({
                            provider,
                            environmentId: environment.environmentId,
                            model: "",
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
              <CatalogPicker
                items={catalog.models}
                value={settings.model || catalog.defaultModel}
                onChange={(model) => {
                  change({ model: model.id, voice: "" });
                  setSheet(null);
                }}
                searchLabel={gt("Search speech models")}
                placeholder={gt("Search speech models")}
                empty={<T>No speech model matches.</T>}
                showAllLabel={(count) =>
                  gt(
                    "{count, plural, one {Show all {count} models} other {Show all {count} models}}",
                    {
                      count,
                    },
                  )
                }
                describe={(model) =>
                  model.install ? (model.recommended ? gt("Recommended") : undefined) : model.id
                }
              />
            ) : voiceChoices.length === 0 ? (
              <ListSection>
                <View className="p-4">
                  <TextInput
                    accessibilityLabel={gt("Read-aloud voice")}
                    placeholder={gt("Default voice")}
                    value={settings.voice}
                    onChangeText={(voice) => change({ voice })}
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="rounded-lg border border-border-subtle px-3 py-2 text-foreground"
                  />
                </View>
                <ListChoiceRow
                  label={gt("Default", { $context: "default voice" })}
                  selected={!settings.voice}
                  onPress={() => {
                    change({ voice: "" });
                    setSheet(null);
                  }}
                />
              </ListSection>
            ) : (
              <CatalogPicker
                items={[
                  { id: "", name: gt("Default", { $context: "default voice" }) },
                  ...voiceChoices,
                ]}
                value={settings.voice}
                onChange={(voice) => {
                  change({ voice: voice.id });
                  setSheet(null);
                }}
                searchLabel={gt("Search voices")}
                placeholder={gt("Search voices")}
                empty={<T>No voice matches.</T>}
                showAllLabel={(count) =>
                  gt(
                    "{count, plural, one {Show all {count} voices} other {Show all {count} voices}}",
                    {
                      count,
                    },
                  )
                }
                describe={() => undefined}
              />
            )}
          </ScrollView>
        </Sheet>
      )}
    </>
  );
}
