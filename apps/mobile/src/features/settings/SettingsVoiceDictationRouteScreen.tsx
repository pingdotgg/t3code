import type { VoiceTranscriptionProvider } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  MOBILE_VOICE_TRANSCRIPTION_PROVIDERS,
  mobileVoiceTranscriptionProviderConfig,
} from "../voice-dictation/mobileVoiceTranscription";
import {
  type MobileVoiceTranscriptionProviderSettingsMap,
  saveMobileVoiceTranscriptionSettings,
  useMobileVoiceTranscriptionSettings,
} from "../voice-dictation/voiceTranscriptionSettings";
import { SettingsSection } from "./components/SettingsSection";

const EMPTY_PROVIDER_SETTINGS: MobileVoiceTranscriptionProviderSettingsMap = {
  openai: {
    apiKey: "",
    model: mobileVoiceTranscriptionProviderConfig("openai").defaultModel,
  },
  groq: {
    apiKey: "",
    model: mobileVoiceTranscriptionProviderConfig("groq").defaultModel,
  },
};

export function SettingsVoiceDictationRouteScreen() {
  const insets = useSafeAreaInsets();
  const settings = useMobileVoiceTranscriptionSettings();
  const [draftProvider, setDraftProvider] = useState<VoiceTranscriptionProvider>("openai");
  const [draftProviders, setDraftProviders] =
    useState<MobileVoiceTranscriptionProviderSettingsMap>(EMPTY_PROVIDER_SETTINGS);
  const [draftInitialized, setDraftInitialized] = useState(false);
  const foreground = useThemeColor("--color-foreground");
  const placeholder = useThemeColor("--color-foreground-muted");
  const checkmarkColor = useThemeColor("--color-icon");
  const providerConfig = mobileVoiceTranscriptionProviderConfig(draftProvider);
  const providerSettings = draftProviders[draftProvider];

  useEffect(() => {
    if (!settings.loaded || draftInitialized) return;
    setDraftProvider(settings.provider);
    setDraftProviders({
      openai: { ...settings.providers.openai },
      groq: { ...settings.providers.groq },
    });
    setDraftInitialized(true);
  }, [draftInitialized, settings.loaded, settings.provider, settings.providers]);

  const updateSelectedProvider = (
    patch: Partial<MobileVoiceTranscriptionProviderSettingsMap[VoiceTranscriptionProvider]>,
  ) => {
    setDraftProviders((current) => ({
      ...current,
      [draftProvider]: { ...current[draftProvider], ...patch },
    }));
  };

  const save = async () => {
    try {
      await saveMobileVoiceTranscriptionSettings({
        provider: draftProvider,
        providers: draftProviders,
      });
      Alert.alert(
        providerSettings.apiKey.trim() ? "Voice dictation enabled" : "Voice dictation disabled",
        providerSettings.apiKey.trim()
          ? `The microphone now uses ${providerConfig.label} with ${providerSettings.model.trim()}.`
          : `No ${providerConfig.label} API key is selected, so the microphone is hidden.`,
      );
    } catch (cause) {
      Alert.alert(
        "Could not save voice dictation",
        cause instanceof Error ? cause.message : "Try again.",
      );
    }
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Provider">
          {MOBILE_VOICE_TRANSCRIPTION_PROVIDERS.map((provider, index) => (
            <Pressable
              key={provider.id}
              accessibilityRole="radio"
              accessibilityState={{
                checked: draftProvider === provider.id,
                disabled: !settings.loaded || settings.saving,
              }}
              disabled={!settings.loaded || settings.saving}
              onPress={() => setDraftProvider(provider.id)}
              className={
                index === 0
                  ? "flex-row items-center gap-4 p-4"
                  : "flex-row items-center gap-4 border-t border-border-subtle p-4"
              }
            >
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-lg text-foreground">{provider.label}</Text>
                <Text className="text-sm text-foreground-muted">
                  {provider.id === "openai"
                    ? "GPT transcription models"
                    : "Fast OpenAI-compatible Whisper models"}
                </Text>
              </View>
              {draftProvider === provider.id ? (
                <SymbolView
                  name="checkmark"
                  size={18}
                  tintColor={checkmarkColor}
                  type="monochrome"
                  weight="semibold"
                />
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>

        <SettingsSection title={`${providerConfig.label} API key`}>
          <View className="gap-3 p-4">
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              editable={settings.loaded && !settings.saving}
              placeholder={draftProvider === "openai" ? "sk-…" : "gsk_…"}
              placeholderTextColor={placeholder}
              secureTextEntry
              value={providerSettings.apiKey}
              onChangeText={(apiKey) => updateSelectedProvider({ apiKey })}
              className="rounded-xl bg-subtle px-4 py-3 text-base"
              style={{ color: foreground }}
              accessibilityLabel={`${providerConfig.label} API key for voice dictation`}
            />
          </View>
        </SettingsSection>

        <SettingsSection title="Model">
          <View className="gap-3 p-4">
            <Text className="text-sm leading-5 text-foreground-muted">
              Choose a known model or enter any compatible model ID.
            </Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              editable={settings.loaded && !settings.saving}
              placeholder={providerConfig.defaultModel}
              placeholderTextColor={placeholder}
              value={providerSettings.model}
              onChangeText={(model) => updateSelectedProvider({ model })}
              className="rounded-xl bg-subtle px-4 py-3 text-base"
              style={{ color: foreground }}
              accessibilityLabel="Voice transcription model ID"
            />
          </View>
          {providerConfig.modelOptions.map((model) => (
            <Pressable
              key={model.id}
              accessibilityRole="radio"
              accessibilityState={{
                checked: providerSettings.model.trim() === model.id,
                disabled: !settings.loaded || settings.saving,
              }}
              disabled={!settings.loaded || settings.saving}
              onPress={() => updateSelectedProvider({ model: model.id })}
              className="flex-row items-center gap-4 border-t border-border-subtle p-4"
            >
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-base text-foreground">{model.label}</Text>
                <Text className="text-sm text-foreground-muted">{model.id}</Text>
              </View>
              {providerSettings.model.trim() === model.id ? (
                <SymbolView
                  name="checkmark"
                  size={18}
                  tintColor={checkmarkColor}
                  type="monochrome"
                  weight="semibold"
                />
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>

        <Pressable
          accessibilityRole="button"
          disabled={!settings.loaded || settings.saving || !providerSettings.model.trim()}
          onPress={() => void save()}
          className="h-11 items-center justify-center rounded-full bg-primary disabled:opacity-50"
        >
          {settings.saving ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className="font-t3-bold text-primary-foreground">Save</Text>
          )}
        </Pressable>

        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          Each provider keeps its own key and model in the iPhone secure store. Audio is sent
          directly to the selected provider. Clearing the selected key hides the microphone.
        </Text>
        {settings.error ? (
          <Text className="px-2 text-sm text-danger-foreground">{settings.error}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
