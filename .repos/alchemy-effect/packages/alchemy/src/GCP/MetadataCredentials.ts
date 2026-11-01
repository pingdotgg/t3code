import { ConfigError } from "@distilled.cloud/core/errors";
import {
  Credentials,
  type Config as CredentialsConfig,
} from "@distilled.cloud/gcp/Credentials";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

/**
 * Credentials sourced from the GCE / Cloud Run metadata server — the
 * runtime identity of a deployed Cloud Run Service, Job, or WorkerPool.
 *
 * Kept dependency-light: the generated container bootstraps import this
 * module, so it must not pull in the deploy-time AuthProvider machinery.
 */

/** A resolved token plus the wall-clock time it stops being valid. */
export interface ExpiringCredentials {
  readonly config: CredentialsConfig;
  /** Epoch millis; `undefined` never expires (e.g. a static env token). */
  readonly expiresAt: number | undefined;
}

/** Refresh this long before the reported expiry. */
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Single-flight, expiry-aware cache over a credential resolver: callers
 * reuse the cached token until it nears expiry, and N concurrent callers
 * observing a stale token trigger exactly one refresh.
 */
export const cacheCredentials = <E, R>(
  resolve: Effect.Effect<ExpiringCredentials, E, R>,
) =>
  Effect.gen(function* () {
    const cache = yield* Ref.make<ExpiringCredentials | undefined>(undefined);
    const lock = yield* Semaphore.make(1);
    const fresh = (current: ExpiringCredentials | undefined, now: number) =>
      current !== undefined &&
      (current.expiresAt === undefined ||
        current.expiresAt - REFRESH_WINDOW_MS > now);
    return Effect.gen(function* () {
      const current = yield* Ref.get(cache);
      if (fresh(current, yield* Clock.currentTimeMillis))
        return current!.config;
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const latest = yield* Ref.get(cache);
          if (fresh(latest, yield* Clock.currentTimeMillis)) {
            return latest!.config;
          }
          const resolved = yield* resolve;
          yield* Ref.set(cache, resolved);
          return resolved.config;
        }),
      );
    });
  });

const METADATA_ROOT = "http://metadata.google.internal/computeMetadata/v1";

const metadataGet = (http: HttpClient.HttpClient, path: string) =>
  http
    .execute(
      HttpClientRequest.get(`${METADATA_ROOT}${path}`).pipe(
        HttpClientRequest.setHeader("Metadata-Flavor", "Google"),
      ),
    )
    .pipe(
      Effect.filterOrFail(
        (response) => response.status === 200,
        (response) =>
          new ConfigError({
            message: `GCE metadata ${path} returned HTTP ${response.status}`,
          }),
      ),
      Effect.mapError((cause) =>
        cause instanceof ConfigError
          ? cause
          : new ConfigError({
              message: `GCE metadata ${path} is unreachable: ${String(cause)}`,
            }),
      ),
    );

/** Mint an access token for the instance's attached service account. */
export const fetchMetadataToken = (http: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const response = yield* metadataGet(
      http,
      "/instance/service-accounts/default/token",
    );
    const body = yield* response.json.pipe(
      Effect.mapError(
        () =>
          new ConfigError({
            message: "GCE metadata token endpoint returned invalid JSON",
          }),
      ),
    );
    const record =
      typeof body === "object" && body !== null
        ? (body as { access_token?: unknown; expires_in?: unknown })
        : {};
    if (typeof record.access_token !== "string") {
      return yield* new ConfigError({
        message: "GCE metadata token endpoint returned no access_token",
      });
    }
    const expiresIn =
      typeof record.expires_in === "number" ? record.expires_in : 300;
    const now = yield* Clock.currentTimeMillis;
    return {
      accessToken: Redacted.make(record.access_token),
      expiresAt: now + expiresIn * 1000,
    };
  });

/** Project id of the instance, from the metadata server. */
export const fetchMetadataProject = (http: HttpClient.HttpClient) =>
  metadataGet(http, "/project/project-id").pipe(
    Effect.flatMap((response) => response.text),
    Effect.map((text) => text.trim()),
    Effect.mapError(
      () =>
        new ConfigError({
          message: "GCE metadata project-id endpoint returned no project",
        }),
    ),
  );

/**
 * Region of the instance (`projects/{n}/regions/{region}` on Cloud Run and
 * Cloud Functions), from the metadata server.
 */
export const fetchMetadataRegion = (http: HttpClient.HttpClient) =>
  metadataGet(http, "/instance/region").pipe(
    Effect.flatMap((response) => response.text),
    Effect.map((text) => text.trim().split("/").pop() || undefined),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * `Credentials` for code running on Cloud Run (or any GCE-backed runtime):
 * the attached service account's token from the metadata server, cached
 * until shortly before expiry. The project comes from
 * `GOOGLE_CLOUD_PROJECT` when set, else from the metadata server once.
 */
export const fromMetadataServer = (): Layer.Layer<
  Credentials,
  never,
  HttpClient.HttpClient
> =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const projectCache = yield* Ref.make<string | undefined>(undefined);
      const project = Effect.gen(function* () {
        const cached = yield* Ref.get(projectCache);
        if (cached !== undefined) return cached;
        const fromEnv = yield* Config.option(
          Config.String("GOOGLE_CLOUD_PROJECT"),
        );
        const resolved = Option.isSome(fromEnv)
          ? fromEnv.value
          : yield* fetchMetadataProject(http);
        yield* Ref.set(projectCache, resolved);
        return resolved;
      });
      // The runtime's default region is the region it runs in.
      const regionCache = yield* Ref.make<string | undefined>(undefined);
      const region = Effect.gen(function* () {
        const cached = yield* Ref.get(regionCache);
        if (cached !== undefined) return cached;
        const resolved = yield* fetchMetadataRegion(http);
        if (resolved !== undefined) yield* Ref.set(regionCache, resolved);
        return resolved;
      });
      const cached = yield* cacheCredentials(
        Effect.gen(function* () {
          const token = yield* fetchMetadataToken(http);
          return {
            config: {
              accessToken: token.accessToken,
              project: yield* project,
              region: yield* region,
            },
            expiresAt: token.expiresAt,
          };
        }),
      );
      // Distilled `Credentials` is `Effect<Config>` (error `never`): a
      // runtime without a metadata server cannot call GCP at all.
      return cached.pipe(Effect.orDie);
    }),
  );
