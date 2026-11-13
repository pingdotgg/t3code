import type { LiveVoiceStart, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";

export const liveVoiceOptions = Effect.fn("liveVoice.options")(function* (
  prepared: PreparedConnection,
  threadId: ThreadId,
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    group: "liveVoice",
    method: "GET",
    timeoutMs: 30_000,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
    url: (urls) => urls.options({ params: { threadId } }),
    request: ({ client, headers }) => client.options({ params: { threadId }, headers }),
  });
});
export const startLiveVoice = Effect.fn("liveVoice.start")(function* (
  prepared: PreparedConnection,
  payload: LiveVoiceStart,
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    group: "liveVoice",
    method: "POST",
    timeoutMs: 40_000,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
    url: (urls) => urls.start(),
    request: ({ client, headers }) => client.start({ payload, headers }),
  });
});
export const pollLiveVoice = Effect.fn("liveVoice.poll")(function* (
  prepared: PreparedConnection,
  sessionId: string,
  revision: number,
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    group: "liveVoice",
    method: "GET",
    timeoutMs: 25_000,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
    url: (urls) => urls.poll({ params: { sessionId }, query: { revision } }),
    request: ({ client, headers }) =>
      client.poll({ params: { sessionId }, query: { revision }, headers }),
  });
});
export const stopLiveVoice = Effect.fn("liveVoice.stop")(function* (
  prepared: PreparedConnection,
  sessionId: string,
) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    group: "liveVoice",
    method: "POST",
    timeoutMs: 10_000,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
    url: (urls) => urls.stop({ params: { sessionId } }),
    request: ({ client, headers }) => client.stop({ params: { sessionId }, headers }),
  });
});
