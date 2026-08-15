import type { VoiceTranscriptionProvider } from "@t3tools/contracts";

export interface MobileVoiceTranscriptionConfig {
  readonly provider: VoiceTranscriptionProvider;
  readonly apiKey: string;
  readonly model: string;
}

export interface MobileVoiceTranscriptionProviderConfig {
  readonly id: VoiceTranscriptionProvider;
  readonly label: string;
  readonly endpoint: string;
  readonly defaultModel: string;
  readonly modelOptions: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
  }>;
}

export const MOBILE_VOICE_TRANSCRIPTION_PROVIDERS: ReadonlyArray<MobileVoiceTranscriptionProviderConfig> =
  [
    {
      id: "openai",
      label: "OpenAI",
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      defaultModel: "gpt-4o-transcribe",
      modelOptions: [
        { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe" },
        { id: "gpt-4o-mini-transcribe", label: "GPT-4o mini Transcribe" },
        { id: "whisper-1", label: "Whisper" },
      ],
    },
    {
      id: "groq",
      label: "Groq",
      endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
      defaultModel: "whisper-large-v3-turbo",
      modelOptions: [
        { id: "whisper-large-v3-turbo", label: "Whisper Large V3 Turbo" },
        { id: "whisper-large-v3", label: "Whisper Large V3" },
      ],
    },
  ];

export function mobileVoiceTranscriptionProviderConfig(
  provider: VoiceTranscriptionProvider,
): MobileVoiceTranscriptionProviderConfig {
  return MOBILE_VOICE_TRANSCRIPTION_PROVIDERS.find((candidate) => candidate.id === provider)!;
}

export async function transcribeMobileVoiceRecording(
  uri: string,
  config: MobileVoiceTranscriptionConfig,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const provider = mobileVoiceTranscriptionProviderConfig(config.provider);
  const form = new FormData();
  form.append("model", config.model.trim());
  form.append("file", {
    uri,
    name: "recording.m4a",
    type: "audio/mp4",
  } as unknown as Blob);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2 * 60 * 1_000);
  try {
    const response = await fetchFn(provider.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey.trim()}` },
      body: form,
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as {
      readonly text?: unknown;
      readonly error?: { readonly message?: unknown };
    } | null;
    if (!response.ok) {
      throw new Error(
        typeof payload?.error?.message === "string"
          ? payload.error.message
          : `${provider.label} rejected the transcription request.`,
      );
    }
    if (typeof payload?.text !== "string") {
      throw new Error(`${provider.label} returned an invalid transcription response.`);
    }
    return payload.text.trim();
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new Error("Voice transcription timed out.", { cause });
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}
