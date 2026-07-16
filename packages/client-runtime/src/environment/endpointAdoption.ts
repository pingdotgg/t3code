import {
  ExecutionEnvironmentDescriptor,
  type AdvertisedEndpoint,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { environmentEndpointUrl, normalizeHttpBaseUrl } from "./endpoint.ts";

export const ADVERTISED_ENDPOINT_PROBE_TIMEOUT_MS = 2_500;

export interface AdoptableEndpoint {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

function validateWsBaseUrl(rawValue: string): string {
  const url = new URL(rawValue);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Endpoint must use WebSocket or secure WebSocket. Received ${url.protocol}`);
  }
  return rawValue;
}

/**
 * The server lists its preferred remote endpoint (e.g. the tailnet HTTPS
 * endpoint published by `tailscale serve`) as the only `isDefault` entry.
 * Older servers omit `advertisedEndpoints` entirely, and a server that just
 * booted may only advertise the direct entry — both mean "keep the base URL
 * the client already has".
 */
export function advertisedDefaultEndpoint(input: {
  readonly advertisedEndpoints: ReadonlyArray<AdvertisedEndpoint> | undefined;
  readonly currentHttpBaseUrl: string;
}): Option.Option<AdoptableEndpoint> {
  const candidate = input.advertisedEndpoints?.find(
    (endpoint) => endpoint.isDefault === true && endpoint.status !== "unavailable",
  );
  if (candidate === undefined) {
    return Option.none();
  }
  try {
    const httpBaseUrl = normalizeHttpBaseUrl(candidate.httpBaseUrl);
    const wsBaseUrl = validateWsBaseUrl(candidate.wsBaseUrl);
    if (httpBaseUrl === normalizeHttpBaseUrl(input.currentHttpBaseUrl)) {
      return Option.none();
    }
    return Option.some({ httpBaseUrl, wsBaseUrl });
  } catch {
    return Option.none();
  }
}

export const probeEnvironmentEndpoint = (input: {
  readonly httpBaseUrl: string;
  readonly expectedEnvironmentId: EnvironmentId;
  readonly timeoutMs?: number;
}): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(
      environmentEndpointUrl(input.httpBaseUrl, "/.well-known/t3/environment"),
    );
    const response = yield* client
      .execute(request)
      .pipe(
        Effect.timeoutOption(
          Duration.millis(input.timeoutMs ?? ADVERTISED_ENDPOINT_PROBE_TIMEOUT_MS),
        ),
      );
    if (Option.isNone(response)) {
      return false;
    }
    const httpResponse = response.value;
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return false;
    }
    const descriptor = yield* httpResponse.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor)),
      Effect.orElseSucceed(() => null),
    );
    return descriptor !== null && descriptor.environmentId === input.expectedEnvironmentId;
  }).pipe(
    Effect.orElseSucceed(() => false),
    Effect.withSpan("clientRuntime.environment.probeEnvironmentEndpoint"),
  );

/**
 * Resolves the advertised endpoint the client should switch to, if any: the
 * descriptor must advertise a default endpoint whose base URL differs from
 * the one currently in use, and that endpoint must answer the environment
 * well-known probe. A client that cannot reach the advertised endpoint (e.g.
 * a phone without Tailscale that paired over LAN) keeps its current URL.
 */
export const resolveAdoptableAdvertisedEndpoint = Effect.fn(
  "clientRuntime.environment.resolveAdoptableAdvertisedEndpoint",
)(function* (input: {
  readonly advertisedEndpoints: ReadonlyArray<AdvertisedEndpoint> | undefined;
  readonly currentHttpBaseUrl: string;
  readonly expectedEnvironmentId: EnvironmentId;
  readonly probeTimeoutMs?: number;
}) {
  const candidate = advertisedDefaultEndpoint(input);
  if (Option.isNone(candidate)) {
    return Option.none<AdoptableEndpoint>();
  }
  const reachable = yield* probeEnvironmentEndpoint({
    httpBaseUrl: candidate.value.httpBaseUrl,
    expectedEnvironmentId: input.expectedEnvironmentId,
    ...(input.probeTimeoutMs === undefined ? {} : { timeoutMs: input.probeTimeoutMs }),
  });
  return reachable ? candidate : Option.none<AdoptableEndpoint>();
});
