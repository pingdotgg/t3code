import {
  EnvironmentAuthInvalidError,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiUrlBuilder,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const DEFAULT_PULL_REQUEST_DIFF_TIMEOUT_MS = 60_000;

export class PullRequestDiffCredentialRejectedError extends Schema.TaggedErrorClass<PullRequestDiffCredentialRejectedError>()(
  "PullRequestDiffCredentialRejectedError",
  {
    repository: Schema.String,
    number: Schema.Number,
    traceId: Schema.String,
    cause: EnvironmentAuthInvalidError,
  },
) {
  override get message(): string {
    return "This environment session is no longer valid (invalid_credential). Refresh the page or quit and reopen T3 Code.";
  }
}

export type PullRequestDiffLoadError =
  | RemoteEnvironmentRequestError
  | PullRequestDiffCredentialRejectedError;

export const fetchEnvironmentPullRequestDiff = Effect.fn(
  "clientRuntime.state.fetchEnvironmentPullRequestDiff",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly diff: PullRequestDiffInput;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = makeEnvironmentHttpApiUrlBuilder(
    input.prepared.httpBaseUrl,
  ).pullRequests.diff();
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_PULL_REQUEST_DIFF_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.pullRequests.diff({ payload: input.diff, headers }),
    ),
  ).pipe(
    Effect.mapError((error) =>
      error._tag === "EnvironmentAuthInvalidError" && error.reason === "invalid_credential"
        ? new PullRequestDiffCredentialRejectedError({
            repository: input.diff.repository,
            number: input.diff.number,
            traceId: error.traceId,
            cause: error,
          })
        : error,
    ),
  );
});

export class PullRequestDiffLoader extends Context.Service<
  PullRequestDiffLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      input: PullRequestDiffInput,
    ) => Effect.Effect<PullRequestDiffResult, PullRequestDiffLoadError>;
  }
>()("@t3tools/client-runtime/state/pullRequestDiffHttp/PullRequestDiffLoader") {}

export const pullRequestDiffLoaderLayer: Layer.Layer<
  PullRequestDiffLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  PullRequestDiffLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return PullRequestDiffLoader.of({
      load: (prepared, input) =>
        fetchEnvironmentPullRequestDiff({ prepared, diff: input, signer }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);
