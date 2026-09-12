import * as Effect from "effect/Effect";
import { SPEECH_STREAM_PATH } from "@t3tools/contracts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";

const VOICE_REQUEST_TIMEOUT_MS = 30 * 60_000;
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
  readonly path: (baseUrl: string) => string;
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
    timeoutMs: VOICE_REQUEST_TIMEOUT_MS,
    requestInit: { redirect: "error" },
    validateUrl: (baseUrl) =>
      Effect.try({
        try: () => {
          const url = new URL(baseUrl);
          const loopback =
            url.hostname === "localhost" ||
            url.hostname === "[::1]" ||
            /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
          if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
            throw new Error("Voice input requires HTTPS for remote environments.");
          }
        },
        catch: (cause) =>
          new RemoteEnvironmentAuthFetchError({
            message: "Voice input requires HTTPS for remote environments.",
            cause,
          }),
      }),
    request: input.run,
  });
});

export const getEnvironmentSpeechStatus = (prepared: PreparedConnection) =>
  request({
    group: "voice",
    prepared,
    method: "GET",
    path: (baseUrl) => makeEnvironmentHttpApiUrlBuilder(baseUrl).voice.status(),
    run: ({ client, headers }) => client.status({ headers }),
  });

export const getEnvironmentSpeechStreamUrl = (prepared: PreparedConnection) => {
  let endpoint = prepared.httpBaseUrl;
  return request({
    group: "auth",
    prepared,
    method: "POST",
    path: (baseUrl) => {
      endpoint = baseUrl;
      return makeEnvironmentHttpApiUrlBuilder(baseUrl).auth.webSocketTicket();
    },
    run: ({ client, headers }) => client.webSocketTicket({ headers }),
  }).pipe(
    Effect.map(({ ticket }) => {
      const url = new URL(SPEECH_STREAM_PATH, endpoint);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("wsTicket", ticket);
      return url.toString();
    }),
  );
};

export const getEnvironmentSpeechModels = (prepared: PreparedConnection) =>
  request({
    group: "voice",
    prepared,
    method: "GET",
    path: (baseUrl) => makeEnvironmentHttpApiUrlBuilder(baseUrl).voice.models(),
    run: ({ client, headers }) => client.models({ headers }),
  });

export const downloadEnvironmentSpeechModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (baseUrl) => makeEnvironmentHttpApiUrlBuilder(baseUrl).voice.downloadModel(),
    run: ({ client, headers }) => client.downloadModel({ headers, payload: { modelId } }),
  });

export const selectEnvironmentSpeechModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (baseUrl) => makeEnvironmentHttpApiUrlBuilder(baseUrl).voice.selectModel(),
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
    path: (baseUrl) => makeEnvironmentHttpApiUrlBuilder(baseUrl).voice.cancelModelDownload(),
    run: ({ client, headers }) => client.cancelModelDownload({ headers, payload: { modelId } }),
  });

export const transcribeEnvironmentPcm = (prepared: PreparedConnection, pcm: Uint8Array) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (baseUrl) => makeEnvironmentHttpApiUrlBuilder(baseUrl).voice.transcribe(),
    run: ({ client, headers }) => client.transcribe({ headers, payload: pcm }),
  });

export const removeEnvironmentSpeechModel = (prepared: PreparedConnection, modelId: string) =>
  request({
    group: "voice",
    prepared,
    method: "POST",
    path: (baseUrl) => makeEnvironmentHttpApiUrlBuilder(baseUrl).voice.removeModel(),
    run: ({ client, headers }) => client.removeModel({ headers, payload: { modelId } }),
  });
