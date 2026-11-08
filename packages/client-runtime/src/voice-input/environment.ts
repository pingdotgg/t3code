import { encodeSpeechPcmRequest } from "@t3tools/shared/speech";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { CloudSpeechError, SPEECH_STREAM_PATH } from "@t3tools/contracts";
import type {
  CloudSpeechModelId,
  CloudSpeechProvider,
  SettingsSecretValue,
  SpeechAcceleration,
  SpeechModelUnloadTimeout,
  SpeechTranscriptionOptions,
  SpeechPostProcessingOptions,
  SpeechCleanupApiProvider,
} from "@t3tools/contracts";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
import { VoiceTranscriptionError } from "./transcription.ts";

const INFERENCE_OR_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const isCloudSpeechError = Schema.is(CloudSpeechError);
type EnvironmentApiClient<G extends "voice" | "auth"> = Effect.Success<
  ReturnType<typeof makeEnvironmentHttpApiGroupClient<G>>
>;

const request = Effect.fn("clientRuntime.voiceInput.environmentRequest")(function* <
  A,
  E,
  G extends "voice" | "auth",
>(input: {
  readonly group: G;
  readonly prepared: PreparedConnection;
  readonly method: "GET" | "POST" | "DELETE";
  readonly timeoutMs?: number;
  readonly canSend?: () => boolean;
  readonly path: (urls: ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>[G]) => string;
  readonly run: (input: {
    readonly client: EnvironmentApiClient<G>;
    readonly headers: { readonly authorization?: string; readonly dpop?: string };
  }) => Effect.Effect<A, E>;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    group: input.group,
    prepared: input.prepared,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
    method: input.method,
    url: input.path,
    timeoutMs: input.timeoutMs ?? 30_000,
    // Audio and credentials never follow a redirect to another host.
    requestInit: { redirect: "error" },
    request: (args) =>
      Effect.suspend(() => (input.canSend?.() === false ? Effect.interrupt : input.run(args))),
  });
});

export const getEnvironmentSpeechStatus = (prepared: PreparedConnection) =>
  request({
    group: "voice",
    prepared,
    method: "GET",
    path: (urls) => urls.status(),
    run: ({ client, headers }) => client.status({ headers }),
  });

export const getCloudSpeechKeys = (prepared: PreparedConnection) =>
  request({
    group: "voice",
    prepared,
    method: "GET",
    path: (urls) => urls.cloudKeys(),
    run: ({ client, headers }) => client.cloudKeys({ headers }),
  });

export const getCloudSpeechModels = (prepared: PreparedConnection) =>
  request({
    group: "voice",
    prepared,
    method: "GET",
    path: (urls) => urls.cloudModels(),
    run: ({ client, headers }) => client.cloudModels({ headers }),
  });

export const getSpeechCleanupModels = (
  prepared: PreparedConnection,
  provider: SpeechCleanupApiProvider,
) =>
  request({
    group: "voice",
    prepared,
    method: "GET",
    path: (urls) => urls.cleanupModels({ params: { provider } }),
    run: ({ client, headers }) => client.cleanupModels({ headers, params: { provider } }),
  });

export const requireCloudSpeechKey = (
  prepared: PreparedConnection,
  provider: CloudSpeechProvider,
) =>
  getCloudSpeechKeys(prepared).pipe(
    Effect.flatMap((keys) =>
      keys[provider]
        ? Effect.void
        : Effect.fail(
            new VoiceTranscriptionError({
              code: "unavailable",
              message: new CloudSpeechError({ provider, reason: "missing-key" }).message,
            }),
          ),
    ),
  );

export const setCloudSpeechKey = (
  prepared: PreparedConnection,
  provider: CloudSpeechProvider,
  key: SettingsSecretValue | null,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.setCloudKey({ params: { provider } }),
    run: ({ client, headers }) =>
      client.setCloudKey({
        headers,
        params: { provider },
        payload: { key: typeof key === "string" ? Redacted.make(key) : key },
      }),
  });

export const transcribeCloudPcm = (
  prepared: PreparedConnection,
  provider: CloudSpeechProvider,
  pcm: Uint8Array,
  options: SpeechTranscriptionOptions,
  canSend: () => boolean,
  model?: CloudSpeechModelId,
) => {
  const query = model === undefined ? {} : { model };
  return request({
    group: "voice",
    prepared,
    method: "POST",
    canSend,
    timeoutMs: 130_000,
    path: (urls) => urls.transcribeCloud({ params: { provider }, query }),
    run: ({ client, headers }) =>
      client.transcribeCloud({
        headers,
        params: { provider },
        query,
        payload: encodeSpeechPcmRequest(pcm, options),
      }),
  }).pipe(
    Effect.mapError((error) =>
      error._tag === "RemoteEnvironmentAuthFetchError" && isCloudSpeechError(error.cause)
        ? new VoiceTranscriptionError({
            code: "transcription-failed",
            message: error.cause.message,
          })
        : error,
    ),
  );
};

export const getEnvironmentSpeechStreamUrl = (prepared: PreparedConnection) => {
  let endpoint = prepared.httpBaseUrl;
  return request({
    group: "auth",
    prepared,
    method: "POST",
    path: (urls) => {
      endpoint = urls.webSocketTicketFor({ params: { use: "media" } });
      return endpoint;
    },
    run: ({ client, headers }) => client.webSocketTicketFor({ headers, params: { use: "media" } }),
  }).pipe(
    Effect.map(({ ticket }) => {
      const url = new URL(SPEECH_STREAM_PATH, endpoint);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("wsTicket", Redacted.value(ticket));
      return url.toString();
    }),
  );
};

export const getEnvironmentSpeechModels = (
  prepared: PreparedConnection,
  includeBenchmarks = false,
) => {
  const query = includeBenchmarks ? { benchmarks: "1" as const } : {};
  return request({
    group: "voice",
    prepared,
    method: "GET",
    path: (urls) => urls.models({ query }),
    run: ({ client, headers }) => client.models({ headers, query }),
  });
};

export const downloadEnvironmentSpeechModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.downloadModel(),
    timeoutMs: INFERENCE_OR_DOWNLOAD_TIMEOUT_MS,
    run: ({ client, headers }) => client.downloadModel({ headers, payload: { modelId } }),
  });

export const selectEnvironmentSpeechModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.selectModel(),
    run: ({ client, headers }) => client.selectModel({ headers, payload: { modelId } }),
  });

export const cancelEnvironmentSpeechModelDownload = (
  prepared: PreparedConnection,
  modelId: string,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.cancelModelDownload(),
    run: ({ client, headers }) => client.cancelModelDownload({ headers, payload: { modelId } }),
  });

export const transcribeEnvironmentPcm = (
  prepared: PreparedConnection,
  pcm: Uint8Array,
  options: SpeechTranscriptionOptions,
  canSend: () => boolean,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.transcribe(),
    canSend,
    timeoutMs: INFERENCE_OR_DOWNLOAD_TIMEOUT_MS,
    run: ({ client, headers }) =>
      client.transcribe({
        headers,
        payload: encodeSpeechPcmRequest(pcm, options),
      }),
  });

/** Sends the transcript and draft context to a provider on `prepared`; a separate opt-in. */
export const postProcessEnvironmentTranscript = (
  prepared: PreparedConnection,
  transcript: string,
  draft: {
    readonly text: string;
    readonly selection: { readonly start: number; readonly end: number };
  },
  options: SpeechPostProcessingOptions,
  canSend: () => boolean,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.postProcess(),
    canSend,
    timeoutMs: INFERENCE_OR_DOWNLOAD_TIMEOUT_MS,
    run: ({ client, headers }) =>
      client.postProcess({ headers, payload: { transcript, draft, options } }),
  });

export const updateEnvironmentSpeechAcceleration = (
  prepared: PreparedConnection,
  acceleration: SpeechAcceleration,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.updateAcceleration(),
    run: ({ client, headers }) => client.updateAcceleration({ headers, payload: { acceleration } }),
  });

export const updateEnvironmentSpeechModelUnloadTimeout = (
  prepared: PreparedConnection,
  timeout: SpeechModelUnloadTimeout,
) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.updateModelUnloadTimeout(),
    run: ({ client, headers }) =>
      client.updateModelUnloadTimeout({ headers, payload: { timeout } }),
  });

export const removeEnvironmentSpeechModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (urls) => urls.removeModel(),
    run: ({ client, headers }) => client.removeModel({ headers, payload: { modelId } }),
  });
