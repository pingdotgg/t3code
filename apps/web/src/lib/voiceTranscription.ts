import type { VoiceTranscriptionProvider } from "@t3tools/contracts";

import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

export interface VoiceTranscriptionConfig {
  readonly provider: VoiceTranscriptionProvider;
  readonly apiKey: string;
  readonly model: string;
}

export type VoiceTranscriptionProviderConfig = Omit<VoiceTranscriptionConfig, "model">;

export interface VoiceTranscriptionEnvironmentStatus {
  readonly openai: boolean;
  readonly groq: boolean;
}

export function voiceTranscriptionRequestHeaders(
  contentType: string,
  config: VoiceTranscriptionConfig,
): Record<string, string> {
  const apiKey = config.apiKey.trim();
  return {
    "content-type": contentType,
    "x-t3-transcription-provider": config.provider,
    "x-t3-transcription-model": config.model.trim(),
    ...(apiKey ? { "x-t3-transcription-api-key": apiKey } : {}),
  };
}

function voiceTranscriptionProviderHeaders(
  config: VoiceTranscriptionProviderConfig,
): Record<string, string> {
  const apiKey = config.apiKey.trim();
  return {
    "x-t3-transcription-provider": config.provider,
    ...(apiKey ? { "x-t3-transcription-api-key": apiKey } : {}),
  };
}

export async function readVoiceTranscriptionEnvironmentStatus(): Promise<VoiceTranscriptionEnvironmentStatus> {
  const bearerToken = await readDesktopPrimaryBearerToken();
  const response = await globalThis.fetch(resolvePrimaryEnvironmentHttpUrl("/api/transcription"), {
    method: "GET",
    credentials: bearerToken ? "omit" : "include",
    ...(bearerToken ? { headers: { authorization: `Bearer ${bearerToken}` } } : {}),
  });
  if (!response.ok) throw new Error("Could not read transcription provider settings.");

  const payload = (await response.json()) as { readonly openai?: unknown; readonly groq?: unknown };
  return {
    openai: payload.openai === true,
    groq: payload.groq === true,
  };
}

export async function listVoiceTranscriptionModels(
  config: VoiceTranscriptionProviderConfig,
): Promise<readonly string[]> {
  const bearerToken = await readDesktopPrimaryBearerToken();
  const response = await globalThis.fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/transcription/models"),
    {
      method: "GET",
      credentials: bearerToken ? "omit" : "include",
      headers: {
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
        ...voiceTranscriptionProviderHeaders(config),
      },
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    readonly models?: unknown;
    readonly error?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string" ? payload.error : "Could not load transcription models.",
    );
  }
  if (
    !Array.isArray(payload?.models) ||
    !payload.models.every((model) => typeof model === "string")
  ) {
    throw new Error("The transcription model response was invalid.");
  }
  return payload.models;
}

export async function transcribeVoiceRecording(
  audio: Blob,
  config: VoiceTranscriptionConfig,
): Promise<string> {
  const bearerToken = await readDesktopPrimaryBearerToken();
  const response = await globalThis.fetch(resolvePrimaryEnvironmentHttpUrl("/api/transcription"), {
    method: "POST",
    credentials: bearerToken ? "omit" : "include",
    headers: {
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      ...voiceTranscriptionRequestHeaders(audio.type || "audio/webm", config),
    },
    body: audio,
  });

  const payload = (await response.json().catch(() => null)) as {
    readonly text?: unknown;
    readonly error?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === "string" ? payload.error : "Voice transcription failed.",
    );
  }
  if (typeof payload?.text !== "string") {
    throw new Error("The transcription response did not contain text.");
  }
  return payload.text.trim();
}
