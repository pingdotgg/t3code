import {
  EnvironmentVoiceHttpError as EnvironmentVoiceHttpErrorSchema,
  type EnvironmentVoiceHttpError,
  VoiceCredentialMutation,
  VoiceRealtimeClientSecretRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PreparedConnection } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequestWithDeclaredError,
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiUrlBuilder,
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthInvalidJsonError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const DEFAULT_VOICE_HTTP_TIMEOUT_MS = 15_000;
const isEnvironmentVoiceHttpError = Schema.is(EnvironmentVoiceHttpErrorSchema);

export type RemoteEnvironmentVoiceRequestError =
  | RemoteEnvironmentRequestError
  | EnvironmentVoiceHttpError;

const redactVoiceRequestError = (
  error: RemoteEnvironmentVoiceRequestError,
): RemoteEnvironmentVoiceRequestError => {
  switch (error._tag) {
    case "RemoteEnvironmentAuthFetchError":
      return new RemoteEnvironmentAuthFetchError({
        message: "The voice environment request failed.",
        cause: "redacted",
      });
    case "RemoteEnvironmentAuthInvalidJsonError":
      return new RemoteEnvironmentAuthInvalidJsonError({
        message: "The voice environment returned an invalid response.",
        cause: "redacted",
      });
    default:
      return error;
  }
};

export const fetchVoiceCredentialStatus = Effect.fn(
  "clientRuntime.state.fetchVoiceCredentialStatus",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = makeEnvironmentHttpApiUrlBuilder(
    input.prepared.httpBaseUrl,
  ).voice.credentialStatus();
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequestWithDeclaredError(
    requestUrl,
    input.timeoutMs ?? DEFAULT_VOICE_HTTP_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.voice.credentialStatus({ headers }),
    ),
    isEnvironmentVoiceHttpError,
  ).pipe(Effect.mapError(redactVoiceRequestError));
});

export const updateVoiceCredential = Effect.fn("clientRuntime.state.updateVoiceCredential")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly mutation: VoiceCredentialMutation;
    readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
    readonly timeoutMs?: number;
  }) {
    const requestUrl = makeEnvironmentHttpApiUrlBuilder(
      input.prepared.httpBaseUrl,
    ).voice.updateCredential();
    const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
    const headers = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      "POST",
      requestUrl,
      input.signer,
    );
    const request = (() => {
      switch (input.mutation.action) {
        case "set":
          return client.voice.updateCredential({ payload: input.mutation, headers });
        case "remove":
          return client.voice.updateCredential({ payload: input.mutation, headers });
      }
    })();
    return yield* executeEnvironmentHttpRequestWithDeclaredError(
      requestUrl,
      input.timeoutMs ?? DEFAULT_VOICE_HTTP_TIMEOUT_MS,
      withEnvironmentCredentials(input.prepared.httpAuthorization, request),
      isEnvironmentVoiceHttpError,
    ).pipe(Effect.mapError(redactVoiceRequestError));
  },
);

export const mintVoiceClientSecret = Effect.fn("clientRuntime.state.mintVoiceClientSecret")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly request: VoiceRealtimeClientSecretRequest;
    readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
    readonly timeoutMs?: number;
  }) {
    const requestUrl = makeEnvironmentHttpApiUrlBuilder(
      input.prepared.httpBaseUrl,
    ).voice.clientSecret();
    const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
    const headers = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      "POST",
      requestUrl,
      input.signer,
    );
    return yield* executeEnvironmentHttpRequestWithDeclaredError(
      requestUrl,
      input.timeoutMs ?? DEFAULT_VOICE_HTTP_TIMEOUT_MS,
      withEnvironmentCredentials(
        input.prepared.httpAuthorization,
        client.voice.clientSecret({ payload: input.request, headers }),
      ),
      isEnvironmentVoiceHttpError,
    ).pipe(Effect.mapError(redactVoiceRequestError));
  },
);
