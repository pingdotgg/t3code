import { EnvironmentHttpCommonError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, type HttpClientResponse } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";
import {
  decodeShellSnapshotDeferringPullRequests,
  type DeferredShellSnapshot,
} from "./shellPullRequests.ts";

// On timeout the socket asks the same server for the same full snapshot, so a
// short deadline only throws the first build away. The socket fallback is for
// setups where /api fails but /ws works, such as a proxy that blocks /api.
const DEFAULT_SHELL_SNAPSHOT_TIMEOUT_MS = 20_000;

export const fetchEnvironmentShellSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentShellSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly timeoutMs?: number;
  readonly omitIdleSubagents?: boolean;
}) {
  const endpoint = {
    query: input.omitIdleSubagents === true ? { omitIdleSubagents: "1" } : {},
  };
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (urls) => urls.shellSnapshot(endpoint),
    timeoutMs: input.timeoutMs ?? DEFAULT_SHELL_SNAPSHOT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client
        .shellSnapshot({
          headers: withOrchestrationProtocolHeader(headers),
          ...endpoint,
          responseMode: "response-only",
        })
        .pipe(Effect.flatMap(decodeShellSnapshotResponse)),
  });
});

const decodeEnvironmentHttpCommonError = Schema.decodeUnknownEffect(
  Schema.toCodecJson(EnvironmentHttpCommonError),
);

const decodeShellSnapshotResponse = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<
  DeferredShellSnapshot,
  HttpClientError.HttpClientError | Schema.SchemaError | EnvironmentHttpCommonError
> => {
  if (response.status === 200) {
    return response.json.pipe(Effect.flatMap(decodeShellSnapshotDeferringPullRequests));
  }
  const statusError = new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({ request: response.request, response }),
  });
  return response.json.pipe(
    Effect.flatMap(decodeEnvironmentHttpCommonError),
    Effect.matchEffect({
      onFailure: () => Effect.fail(statusError),
      onSuccess: Effect.fail,
    }),
  );
};

export class ShellSnapshotLoader extends Context.Service<
  ShellSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      options?: { readonly omitIdleSubagents?: boolean },
    ) => Effect.Effect<Option.Option<DeferredShellSnapshot>>;
  }
>()("@t3tools/client-runtime/state/shellSnapshotHttp/ShellSnapshotLoader") {}

export const layer: Layer.Layer<ShellSnapshotLoader, never, HttpClient.HttpClient> = Layer.effect(
  ShellSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    // Resolve the DPoP signer optionally: it is only needed for relay/DPoP
    // connections, so the loader must not hard-require it.
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    return ShellSnapshotLoader.of({
      load: (prepared, options) =>
        fetchEnvironmentShellSnapshot({
          prepared,
          signer,
          remoteAuthorization,
          ...(options?.omitIdleSubagents === true ? { omitIdleSubagents: true } : {}),
        }).pipe(
          Effect.map(Option.some<DeferredShellSnapshot>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the environment shell snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<DeferredShellSnapshot>()),
            ),
          ),
        ),
    });
  }),
);
