import { RelayApi } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

/**
 * A typed RelayApi client that authenticates as this environment, for the
 * environment-credential endpoints (link preferences, held webhooks).
 */
export const makeRelayEnvironmentClient = (connection: {
  readonly url: string;
  readonly environmentCredential: string;
}) =>
  HttpApiClient.make(RelayApi, {
    baseUrl: connection.url,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeader("authorization", `Bearer ${connection.environmentCredential}`),
    ),
  }).pipe(Effect.provide(FetchHttpClient.layer));
