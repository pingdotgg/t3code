import type { ProviderInstanceId, VoicePolishStyle } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { makeEnvironmentHttpApiGroupClient } from "../rpc/http.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  type EnvironmentHttpAuthHeaders,
} from "../state/environmentHttpAuth.ts";

type VoiceClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<"voice">>>;

const requestVoice = Effect.fn("voiceInput.requestVoice")(function* <A, E, R>(
  prepared: PreparedConnection,
  path: string,
  request: (input: {
    client: VoiceClient;
    headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    group: "voice",
    method: "POST",
    timeoutMs: 45_000,
    url: (base) => environmentEndpointUrl(base, path),
    request,
  });
});

export const voiceAvailability = (prepared: PreparedConnection, instanceId: ProviderInstanceId) =>
  requestVoice(prepared, "/api/voice/availability", ({ client, headers }) =>
    client.availability({ headers, payload: { instanceId } }),
  );
export const startVoice = (
  prepared: PreparedConnection,
  instanceId: ProviderInstanceId,
  sdp: string,
) =>
  requestVoice(prepared, "/api/voice/start", ({ client, headers }) =>
    client.start({ headers, payload: { instanceId, sdp } }),
  );
export const stopVoice = (prepared: PreparedConnection, sessionId: string) =>
  requestVoice(prepared, "/api/voice/stop", ({ client, headers }) =>
    client.stop({ headers, payload: { sessionId } }),
  );

export const finishVoice = (prepared: PreparedConnection, sessionId: string, text: string) =>
  requestVoice(prepared, "/api/voice/finish", ({ client, headers }) =>
    client.finish({ headers, payload: { sessionId, text } }),
  );

export const polishVoice = (
  prepared: PreparedConnection,
  instanceId: ProviderInstanceId,
  text: string,
  style: VoicePolishStyle,
) =>
  requestVoice(prepared, "/api/voice/polish", ({ client, headers }) =>
    client.polish({ headers, payload: { instanceId, text, style } }),
  );
