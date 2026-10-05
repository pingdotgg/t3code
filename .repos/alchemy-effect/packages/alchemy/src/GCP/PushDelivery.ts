import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import { isGcpListenHost, type GcpHostRuntimeContext } from "./HostContext.ts";
import { Member } from "./IAM/Member.ts";
import { unverifiedAudience, verifyGoogleIdToken } from "./Oidc.ts";

/**
 * Shared scaffolding for event sources that deliver over HTTPS to a GCP
 * host (Pub/Sub push, Cloud Scheduler): the host's endpoint and push
 * identity, the `run.invoker` grant, the delivery path, and per-request
 * OIDC verification.
 *
 * NOT exported from `index.ts`.
 */

/** An HTTP-serving GCP host: `GCP.Run.Service` or `GCP.CloudFunctions.Function`. */
export type PushHost = GcpHostRuntimeContext & {
  LogicalId: string;
  Type: string;
};

export class PushHostRequired extends Error {
  constructor(source: string, host: string | undefined) {
    super(
      `${source} delivers over HTTPS and needs a GCP.Run.Service (GCP.Function) or GCP.CloudFunctions.Function host; got ${host ?? "no host"}. Use GCP.Run.TopicPullEventSource on Jobs and WorkerPools.`,
    );
  }
}

/** The ambient push host, or a defect naming what is missing. */
export const pushHost = (source: string) =>
  Effect.gen(function* () {
    const host = yield* Binding.Host;
    if (!isGcpListenHost(host)) {
      return yield* Effect.die(
        new PushHostRequired(source, (host as { Type?: string })?.Type),
      );
    }
    return host as PushHost;
  });

/**
 * Deploy-time outputs of the host an event source delivers to. The host's
 * runtime service account is the push identity, so no extra account is
 * minted and the runtime can check the token's email against its own.
 */
export const hostEndpoint = (host: PushHost) => {
  const attrs = host as unknown as Record<string, Output.Output<string>>;
  return host.Type === "GCP.CloudFunctions.Function"
    ? {
        // The function's Cloud Run URL: the address Cloud Run's front end
        // validates token audiences against.
        url: attrs.uri!,
        serviceAccount: attrs.serviceAccountEmail!,
        // Gen2 functions are invoked through their Cloud Run service.
        invokerService: attrs.service!,
      }
    : {
        url: attrs.uri!,
        serviceAccount: attrs.serviceAccount!,
        invokerService: attrs.name!,
      };
};

/** Deterministic path segment for a logical id. */
export const pathSegment = (value: string) =>
  value.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();

/**
 * OIDC audience for one delivery route: the route's own URL on the host.
 * Cloud Run's front end only accepts tokens addressed to the service's
 * URL (or a configured custom audience) when the invoker check is on, and
 * binding the path means a token minted for one route is rejected on
 * every other.
 */
export const deliveryAudience = (url: Output.Output<string>, path: string) =>
  Output.interpolate`${url}${path}`;

/**
 * The audience a delivery to `path` must carry. Cloud Run routes on the
 * `Host` header, so it names the URL the sender addressed — the same URL
 * `deliveryAudience` pinned into the push config.
 */
const expectedAudience = (request: HttpServerRequest, path: string) =>
  `https://${request.headers["host"] ?? ""}${path}`;

/**
 * Let the host's runtime service account invoke the host, so Cloud Run
 * accepts the OIDC-authenticated deliveries even when the service requires
 * authentication.
 */
export const grantSelfInvoker = (host: PushHost) =>
  Effect.gen(function* () {
    const endpoint = hostEndpoint(host);
    const member = yield* Member;
    yield* member(`${host.LogicalId}-PushInvoker`, {
      kind: "run.service",
      name: endpoint.invokerService,
      role: "roles/run.invoker",
      member: Output.interpolate`serviceAccount:${endpoint.serviceAccount}`,
    });
  });

let runtimeEmail: string | undefined;

/** The instance's own service account email, from the metadata server. */
const ownServiceAccount = Effect.gen(function* () {
  if (runtimeEmail !== undefined) return runtimeEmail;
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(
    HttpClientRequest.get(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
    ).pipe(HttpClientRequest.setHeader("Metadata-Flavor", "Google")),
  );
  const email = (yield* response.text).trim();
  runtimeEmail = email;
  return email;
});

const unauthorized = HttpServerResponse.text("unauthorized", { status: 401 });
const unavailable = HttpServerResponse.text("unavailable", { status: 503 });

/**
 * Claim `POST {path}` deliveries: verify the OIDC token (audience + the
 * host's own service account), then run `handle`. Any other request is
 * left for the next listener or the user's `fetch`.
 */
export const listenForDeliveries = (
  host: PushHost,
  path: string,
  handle: (
    request: HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, any>,
) =>
  host.listen((request) => {
    const pathname = new URL(request.url, "http://host").pathname;
    if (pathname !== path) return undefined;
    return Effect.gen(function* () {
      if (request.method !== "POST") {
        return HttpServerResponse.text("method not allowed", { status: 405 });
      }
      // Infrastructure failures (metadata server, Google's signing keys)
      // answer 503 so the sender retries instead of dropping the event.
      const email = yield* ownServiceAccount.pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Cannot read the instance service account", error),
        ),
        Effect.option,
      );
      if (email._tag === "None") return unavailable;
      const verified = yield* verifyGoogleIdToken({
        authorization: request.headers["authorization"],
        audience: expectedAudience(request, path),
        email: email.value,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Cannot load Google's signing keys", error),
        ),
        Effect.option,
      );
      if (verified._tag === "None") return unavailable;
      if (!verified.value) {
        yield* Effect.logWarning(
          `Rejected delivery to ${path}: invalid OIDC token (aud=${unverifiedAudience(request.headers["authorization"]) ?? "none"})`,
        );
        return unauthorized;
      }
      return yield* handle(request);
    });
  });
