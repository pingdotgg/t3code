import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type { HttpMethod } from "effect/http/HttpMethod";
import { bindGcpHost } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";
import {
  InvokeService,
  InvokeServiceError,
  type InvokeServiceRequestInit,
  type InvokeServiceResponse,
} from "./InvokeService.ts";
import type { Service } from "./Service.ts";

const IDENTITY_ENDPOINT =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

/** Refresh this long before the token's `exp`. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** Google ID tokens live one hour; used when `exp` cannot be decoded. */
const DEFAULT_LIFETIME_MS = 55 * 60 * 1000;

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

/** Epoch millis of a JWT's `exp` claim, if present. */
const jwtExpiry = (token: string): number | undefined => {
  try {
    const payload = token.split(".")[1];
    if (payload === undefined) return undefined;
    const json = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
};

/** Mint a Google-signed ID token for `audience` from the metadata server. */
const fetchIdToken = (http: HttpClient.HttpClient, audience: string) =>
  Effect.gen(function* () {
    const response = yield* http.execute(
      HttpClientRequest.get(IDENTITY_ENDPOINT).pipe(
        HttpClientRequest.setUrlParams({ audience, format: "full" }),
        HttpClientRequest.setHeader("Metadata-Flavor", "Google"),
      ),
    );
    const body = yield* response.text;
    if (response.status !== 200) {
      return yield* new InvokeServiceError({
        message: `GCE metadata identity endpoint returned HTTP ${response.status}: ${body}`,
      });
    }
    const token = body.trim();
    const now = yield* Clock.currentTimeMillis;
    return {
      token,
      expiresAt: jwtExpiry(token) ?? now + DEFAULT_LIFETIME_MS,
    } satisfies CachedToken;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof InvokeServiceError
        ? cause
        : new InvokeServiceError({
            message: `GCE metadata identity endpoint is unreachable: ${String(cause)}`,
            cause,
          }),
    ),
  );

/** Single-flight, expiry-aware ID token cache for one audience. */
const makeIdTokenCache = (http: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const cache = yield* Ref.make<CachedToken | undefined>(undefined);
    const lock = yield* Semaphore.make(1);
    const fresh = (current: CachedToken | undefined, now: number) =>
      current !== undefined && current.expiresAt - REFRESH_WINDOW_MS > now;
    return (audience: string) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(cache);
        if (fresh(current, yield* Clock.currentTimeMillis)) {
          return current!.token;
        }
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const latest = yield* Ref.get(cache);
            if (fresh(latest, yield* Clock.currentTimeMillis)) {
              return latest!.token;
            }
            const minted = yield* fetchIdToken(http, audience);
            yield* Ref.set(cache, minted);
            return minted.token;
          }),
        );
      });
  });

/**
 * HTTP implementation of {@link InvokeService}: ID tokens from the Cloud
 * Run metadata server, requests over the ambient `HttpClient`.
 *
 * @layer
 * @provides GCP.Run.InvokeService
 */
export const InvokeServiceHttp: Layer.Layer<
  InvokeService,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  InvokeService,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Effect.fn(function* <T extends Service>(service: T) {
      yield* bindGcpHost({
        tag: "GCP.Run.InvokeService",
        resource: service,
        iam: [
          grantFor(
            { role: "roles/run.invoker", on: "run.service" },
            service.name,
          ),
        ],
      });
      const uri = yield* service.uri;
      const idToken = yield* makeIdTokenCache(http);

      const fetch = Effect.fn(`GCP.Run.InvokeService(${service.LogicalId})`)(
        function* (path: string, init?: InvokeServiceRequestInit) {
          const base = yield* uri;
          if (base === undefined) {
            return yield* new InvokeServiceError({
              message: `Cloud Run service ${service.LogicalId} has no URI`,
            });
          }
          const audience = base.replace(/\/+$/, "");
          const token = yield* idToken(audience);
          const url = `${audience}/${path.replace(/^\/+/, "")}`;
          let request = HttpClientRequest.make(
            (init?.method?.toUpperCase() ?? "GET") as HttpMethod,
          )(url).pipe(
            HttpClientRequest.setHeaders(init?.headers ?? {}),
            HttpClientRequest.bearerToken(token),
          );
          if (init?.body !== undefined) {
            const contentType =
              init.headers?.["content-type"] ?? init.headers?.["Content-Type"];
            request =
              typeof init.body === "string"
                ? HttpClientRequest.bodyText(request, init.body, contentType)
                : HttpClientRequest.bodyUint8Array(
                    request,
                    init.body,
                    contentType,
                  );
          }
          const response = yield* http.execute(request).pipe(
            Effect.mapError(
              (cause) =>
                new InvokeServiceError({
                  message: `Request to ${url} failed: ${cause.message}`,
                  cause,
                }),
            ),
          );
          const text = yield* response.text.pipe(
            Effect.mapError(
              (cause) =>
                new InvokeServiceError({
                  message: `Reading the response from ${url} failed: ${cause.message}`,
                  cause,
                }),
            ),
          );
          return {
            status: response.status,
            headers: { ...response.headers },
            text: Effect.succeed(text),
            json: Effect.try({
              try: () => JSON.parse(text) as unknown,
              catch: (cause) =>
                new InvokeServiceError({
                  message: `Response from ${url} is not JSON`,
                  cause,
                }),
            }),
          } satisfies InvokeServiceResponse;
        },
      );
      return { fetch };
    });
  }),
);
