import type { VoiceTranscriptionProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { runPrimaryRawHttp } from "./runtime";

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

async function executeVoiceTranscriptionJsonRequest(
  request: HttpClientRequest.HttpClientRequest,
  failureMessage: string,
): Promise<{ readonly status: number; readonly payload: unknown }> {
  try {
    return await runPrimaryRawHttp(
      HttpClient.execute(request).pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((payload) => ({ status: response.status, payload })),
          ),
        ),
      ),
    );
  } catch (cause) {
    throw new Error(failureMessage, { cause });
  }
}

export async function readVoiceTranscriptionEnvironmentStatus(): Promise<VoiceTranscriptionEnvironmentStatus> {
  const { status, payload } = await executeVoiceTranscriptionJsonRequest(
    HttpClientRequest.get(resolvePrimaryEnvironmentHttpUrl("/api/transcription")),
    "Could not read transcription provider settings.",
  );
  if (status < 200 || status >= 300) {
    throw new Error("Could not read transcription provider settings.");
  }
  const value = payload as { readonly openai?: unknown; readonly groq?: unknown } | null;
  return {
    openai: value?.openai === true,
    groq: value?.groq === true,
  };
}

export async function listVoiceTranscriptionModels(
  config: VoiceTranscriptionProviderConfig,
): Promise<readonly string[]> {
  const request = HttpClientRequest.get(
    resolvePrimaryEnvironmentHttpUrl("/api/transcription/models"),
  ).pipe(HttpClientRequest.setHeaders(voiceTranscriptionProviderHeaders(config)));
  const { status, payload } = await executeVoiceTranscriptionJsonRequest(
    request,
    "Could not load transcription models.",
  );
  const value = payload as {
    readonly models?: unknown;
    readonly error?: unknown;
  } | null;
  if (status < 200 || status >= 300) {
    throw new Error(
      typeof value?.error === "string" ? value.error : "Could not load transcription models.",
    );
  }
  if (!Array.isArray(value?.models) || !value.models.every((model) => typeof model === "string")) {
    throw new Error("The transcription model response was invalid.");
  }
  return value.models;
}

export async function transcribeVoiceRecording(
  audio: Blob,
  config: VoiceTranscriptionConfig,
): Promise<string> {
  const contentType = audio.type || "audio/webm";
  const audioBytes = new Uint8Array(await audio.arrayBuffer());
  const request = HttpClientRequest.post(
    resolvePrimaryEnvironmentHttpUrl("/api/transcription"),
  ).pipe(
    HttpClientRequest.bodyUint8Array(audioBytes, contentType),
    HttpClientRequest.setHeaders(voiceTranscriptionRequestHeaders(contentType, config)),
  );
  const { status, payload } = await executeVoiceTranscriptionJsonRequest(
    request,
    "Voice transcription failed.",
  );
  const value = payload as {
    readonly text?: unknown;
    readonly error?: unknown;
  } | null;
  if (status < 200 || status >= 300) {
    throw new Error(typeof value?.error === "string" ? value.error : "Voice transcription failed.");
  }
  if (typeof value?.text !== "string") {
    throw new Error("The transcription response did not contain text.");
  }
  return value.text.trim();
}
