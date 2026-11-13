import { EnvironmentHttpCommonError, OrchestrationV2ShellResumable } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
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

export interface ShellSnapshotOptions {
  readonly omitIdleSubagents?: boolean;
  readonly omitOlderSettled?: boolean;
  /** The cursor of held rows loaded with these omissions; the server may answer `resumable`. */
  readonly resumeFrom?: number;
}

/** `projectIdentities` names the repository identities the snapshot carried. */
export interface ShellHttpSnapshot extends DeferredShellSnapshot {
  readonly projectIdentities?: string;
}

export type ShellHttpAnswer = ShellHttpSnapshot | OrchestrationV2ShellResumable;

// On timeout the socket asks the same server for the same full snapshot, so a
// short deadline only throws the first build away. The socket fallback is for
// setups where /api fails but /ws works, such as a proxy that blocks /api.
const DEFAULT_SHELL_SNAPSHOT_TIMEOUT_MS = 20_000;

export const fetchEnvironmentShellSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentShellSnapshot",
)(function* (
  input: {
    readonly prepared: PreparedConnection;
    readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
    readonly remoteAuthorization?: Option.Option<
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
    >;
    readonly timeoutMs?: number;
  } & ShellSnapshotOptions,
) {
  const endpoint = {
    query: {
      ...(input.omitIdleSubagents === true
        ? { omitIdleSubagents: "1", omitIdleSubagentParents: "1" }
        : {}),
      ...(input.omitOlderSettled === true ? { omitOlderSettled: "1" } : {}),
      ...(input.resumeFrom === undefined ? {} : { resumeFrom: String(input.resumeFrom) }),
    },
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

const isShellResumable = Schema.is(OrchestrationV2ShellResumable);

const decodeShellSnapshotResponse = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<
  ShellHttpAnswer,
  HttpClientError.HttpClientError | Schema.SchemaError | EnvironmentHttpCommonError
> => {
  if (response.status === 200) {
    return response.json.pipe(
      Effect.flatMap((json): Effect.Effect<ShellHttpAnswer, Schema.SchemaError> => {
        if (isShellResumable(json)) return Effect.succeed(json);
        const projectIdentities =
          Predicate.isObject(json) && typeof json.projectIdentities === "string"
            ? json.projectIdentities
            : undefined;
        return decodeShellSnapshotDeferringPullRequests(json).pipe(
          Effect.map((snapshot) =>
            projectIdentities === undefined ? snapshot : { ...snapshot, projectIdentities },
          ),
        );
      }),
    );
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
      options?: ShellSnapshotOptions,
    ) => Effect.Effect<Option.Option<ShellHttpAnswer>>;
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
      load: Effect.fn("ShellSnapshotLoader.load")(function (prepared, options) {
        return fetchEnvironmentShellSnapshot({
          prepared,
          signer,
          remoteAuthorization,
          ...options,
        }).pipe(
          Effect.map(Option.some<ShellHttpAnswer>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the environment shell snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              Effect.as(Option.none<ShellHttpAnswer>()),
            ),
          ),
        );
      }),
    });
  }),
);
