import type { VoiceTranscriptionProvider } from "@t3tools/contracts";
import * as SecureStore from "expo-secure-store";
import { useEffect, useSyncExternalStore } from "react";

import {
  type MobileVoiceTranscriptionConfig,
  mobileVoiceTranscriptionProviderConfig,
} from "./mobileVoiceTranscription";

const LEGACY_OPENAI_API_KEY_STORAGE_KEY = "t3code.voice-transcription.openai-api-key";
const SETTINGS_STORAGE_KEY = "t3code.voice-transcription.settings.v2";

export interface MobileVoiceTranscriptionProviderSettings {
  readonly apiKey: string;
  readonly model: string;
}

export type MobileVoiceTranscriptionProviderSettingsMap = Readonly<
  Record<VoiceTranscriptionProvider, MobileVoiceTranscriptionProviderSettings>
>;

export interface MobileVoiceTranscriptionSettingsSnapshot {
  readonly provider: VoiceTranscriptionProvider;
  readonly providers: MobileVoiceTranscriptionProviderSettingsMap;
  readonly error: string | null;
  readonly loaded: boolean;
  readonly saving: boolean;
}

function defaultProviderSettings(): MobileVoiceTranscriptionProviderSettingsMap {
  return {
    openai: {
      apiKey: "",
      model: mobileVoiceTranscriptionProviderConfig("openai").defaultModel,
    },
    groq: {
      apiKey: "",
      model: mobileVoiceTranscriptionProviderConfig("groq").defaultModel,
    },
  };
}

let snapshot: MobileVoiceTranscriptionSettingsSnapshot = {
  provider: "openai",
  providers: defaultProviderSettings(),
  error: null,
  loaded: false,
  saving: false,
};
let loadPromise: Promise<void> | null = null;
let revision = 0;
const listeners = new Set<() => void>();

function publish(next: MobileVoiceTranscriptionSettingsSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function normalizeProvider(value: unknown): VoiceTranscriptionProvider {
  return value === "groq" ? "groq" : "openai";
}

function normalizeProviderSettings(
  value: unknown,
  provider: VoiceTranscriptionProvider,
): MobileVoiceTranscriptionProviderSettings {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as { readonly apiKey?: unknown; readonly model?: unknown })
      : null;
  const model = typeof candidate?.model === "string" ? candidate.model.trim() : "";
  return {
    apiKey: typeof candidate?.apiKey === "string" ? candidate.apiKey.trim() : "",
    model: model || mobileVoiceTranscriptionProviderConfig(provider).defaultModel,
  };
}

function parseStoredSettings(
  value: string,
): Pick<MobileVoiceTranscriptionSettingsSnapshot, "provider" | "providers"> {
  const parsed = JSON.parse(value) as {
    readonly provider?: unknown;
    readonly providers?: { readonly openai?: unknown; readonly groq?: unknown };
  };
  return {
    provider: normalizeProvider(parsed.provider),
    providers: {
      openai: normalizeProviderSettings(parsed.providers?.openai, "openai"),
      groq: normalizeProviderSettings(parsed.providers?.groq, "groq"),
    },
  };
}

export function loadMobileVoiceTranscriptionSettings(): Promise<void> {
  if (snapshot.loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  const loadRevision = revision;
  loadPromise = Promise.all([
    SecureStore.getItemAsync(SETTINGS_STORAGE_KEY),
    SecureStore.getItemAsync(LEGACY_OPENAI_API_KEY_STORAGE_KEY),
  ])
    .then(([storedSettings, legacyOpenAiApiKey]) => {
      if (revision !== loadRevision) return;
      if (storedSettings) {
        try {
          const parsed = parseStoredSettings(storedSettings);
          publish({ ...parsed, error: null, loaded: true, saving: false });
          return;
        } catch {
          publish({
            provider: "openai",
            providers: defaultProviderSettings(),
            error: "Saved voice dictation settings were invalid. Save them again.",
            loaded: true,
            saving: false,
          });
          return;
        }
      }
      const providers = defaultProviderSettings();
      publish({
        provider: "openai",
        providers: {
          ...providers,
          openai: { ...providers.openai, apiKey: legacyOpenAiApiKey?.trim() ?? "" },
        },
        error: null,
        loaded: true,
        saving: false,
      });
    })
    .catch(() => {
      if (revision !== loadRevision) return;
      publish({
        provider: "openai",
        providers: defaultProviderSettings(),
        error: "Could not read the saved voice dictation settings.",
        loaded: false,
        saving: false,
      });
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

export async function saveMobileVoiceTranscriptionSettings(input: {
  readonly provider: VoiceTranscriptionProvider;
  readonly providers: MobileVoiceTranscriptionProviderSettingsMap;
}): Promise<void> {
  const providers: MobileVoiceTranscriptionProviderSettingsMap = {
    openai: normalizeProviderSettings(input.providers.openai, "openai"),
    groq: normalizeProviderSettings(input.providers.groq, "groq"),
  };
  revision += 1;
  const previous = snapshot;
  publish({ ...snapshot, error: null, saving: true });
  try {
    await SecureStore.setItemAsync(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ provider: input.provider, providers }),
    );
    await SecureStore.deleteItemAsync(LEGACY_OPENAI_API_KEY_STORAGE_KEY).catch(() => undefined);
    publish({
      provider: input.provider,
      providers,
      error: null,
      loaded: true,
      saving: false,
    });
  } catch {
    publish({ ...previous, error: "Could not save voice dictation settings.", saving: false });
    throw new Error("Could not save voice dictation settings.");
  }
}

export function activeMobileVoiceTranscriptionConfig(
  settings: Pick<MobileVoiceTranscriptionSettingsSnapshot, "provider" | "providers">,
): MobileVoiceTranscriptionConfig {
  return {
    provider: settings.provider,
    ...settings.providers[settings.provider],
  };
}

export function getMobileVoiceTranscriptionSettingsSnapshot(): MobileVoiceTranscriptionSettingsSnapshot {
  return snapshot;
}

export function useMobileVoiceTranscriptionSettings() {
  const current = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
  useEffect(() => {
    void loadMobileVoiceTranscriptionSettings();
  }, []);
  return current;
}
