import type {
  EnvironmentSpeechStatus,
  EnvironmentSpeechTranscriptionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { makeEnvironmentHttpApiClient, makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";

const VOICE_REQUEST_TIMEOUT_MS = 10 * 60_000;
type EnvironmentApiClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;

const request = Effect.fn("clientRuntime.voiceInput.environmentRequest")(function* <A>(input: {
  readonly prepared: PreparedConnection;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: (baseUrl: string) => string;
  readonly run: (input: {
    readonly client: EnvironmentApiClient;
    readonly headers: { readonly authorization?: string; readonly dpop?: string };
  }) => Effect.Effect<A, unknown>;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
    method: input.method,
    url: input.path,
    timeoutMs: VOICE_REQUEST_TIMEOUT_MS,
    request: input.run,
  });
});

export const getEnvironmentSpeechStatus = (prepared: PreparedConnection) =>
  request<EnvironmentSpeechStatus>({
    prepared,
    method: "GET",
    path: (baseUrl) => makeEnvironmentHttpApiUrlBuilder(baseUrl).voice.status(),
    run: ({ client, headers }) => client.voice.status({ headers }),
  });

export const transcribeEnvironmentPcm = (prepared: PreparedConnection, pcm: Uint8Array) =>
  request<EnvironmentSpeechTranscriptionResult>({
    prepared,
    method: "POST",
    path: (baseUrl) => makeEnvironmentHttpApiUrlBuilder(baseUrl).voice.transcribe(),
    run: ({ client, headers }) => client.voice.transcribe({ headers, payload: pcm }),
  });

export const removeEnvironmentSpeechModel = (prepared: PreparedConnection) =>
  request<EnvironmentSpeechStatus>({
    prepared,
    method: "DELETE",
    path: (baseUrl) => makeEnvironmentHttpApiUrlBuilder(baseUrl).voice.removeModel(),
    run: ({ client, headers }) => client.voice.removeModel({ headers }),
  });
