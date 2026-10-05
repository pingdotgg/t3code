import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { getEnv } from "./Env.ts";

/**
 * Platform-issued OIDC tokens, for exchanging with a secrets manager's OIDC
 * identity auth (Doppler service account identities, Infisical machine
 * identities) so CI never holds a long-lived credential.
 *
 * | Platform       | Marker variable   | Token source                               |
 * | -------------- | ----------------- | ------------------------------------------ |
 * | explicit       | the caller's env  | the variable itself                        |
 * | Vercel         | `VERCEL`          | `VERCEL_OIDC_TOKEN`                        |
 * | GitHub Actions | `GITHUB_ACTIONS`  | `ACTIONS_ID_TOKEN_REQUEST_URL` + token     |
 * | GitLab CI      | `GITLAB_CI`       | `SIGSTORE_ID_TOKEN` from `id_tokens`        |
 * | GCP            | `K_SERVICE` etc.  | the metadata server's identity endpoint    |
 */
export type OidcPlatform =
  | "explicit"
  | "vercel"
  | "github-actions"
  | "gitlab"
  | "gcp";

export interface OidcToken {
  readonly platform: OidcPlatform;
  readonly token: Redacted.Redacted<string>;
}

/** Which env vars a provider reserves for its explicit token and audience. */
export interface OidcTokenEnv {
  /** Explicit override for platforms that are not auto-detected. */
  readonly token: string;
  /** Optional `aud` claim to request where the platform supports it. */
  readonly audience: string;
}

/** The platforms {@link detectOidcToken} knows, for error messages. */
export const SUPPORTED_OIDC_PLATFORMS =
  "Vercel, GitHub Actions (needs `permissions: id-token: write`), GitLab CI (needs `id_tokens`), and GCP";

/** Metadata and internal endpoints answer fast or not at all. */
const PROBE_TIMEOUT = Duration.seconds(5);

const GitHubTokenResponse = Schema.Struct({
  value: Schema.optional(Schema.String),
});

/**
 * One probe per platform, each gated on a variable the platform's runtime
 * always sets, so a laptop never waits on a DNS lookup for an internal
 * endpoint. A probe yields the token, or `undefined` when the platform is
 * absent or has nothing to give.
 */
const PLATFORMS: ReadonlyArray<{
  readonly name: OidcPlatform;
  readonly probe: (
    audience: string | undefined,
  ) => Effect.Effect<
    Redacted.Redacted<string> | undefined,
    unknown,
    HttpClient.HttpClient
  >;
}> = [
  {
    name: "vercel",
    probe: Effect.fn("oidc.vercel")(function* () {
      if (!(yield* getEnv("VERCEL"))) return undefined;
      const token = yield* getEnv("VERCEL_OIDC_TOKEN");
      return token ? Redacted.make(token) : undefined;
    }),
  },
  {
    // A per-job request URL and bearer, present only with
    // `permissions: id-token: write` on the workflow or job.
    name: "github-actions",
    probe: Effect.fn("oidc.githubActions")(function* (audience) {
      if (!(yield* getEnv("GITHUB_ACTIONS"))) return undefined;
      const requestUrl = yield* getEnv("ACTIONS_ID_TOKEN_REQUEST_URL");
      const bearer = yield* getEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
      if (!requestUrl || !bearer) return undefined;

      const url = new URL(requestUrl);
      if (audience !== undefined) url.searchParams.set("audience", audience);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(url, {
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/json; api-version=2.0",
        },
      });
      if (response.status !== 200) return undefined;
      const body =
        yield* HttpClientResponse.schemaBodyJson(GitHubTokenResponse)(response);
      return body.value ? Redacted.make(body.value) : undefined;
    }),
  },
  {
    // The job's `id_tokens` block names the variable; these are the common ones.
    name: "gitlab",
    probe: Effect.fn("oidc.gitlab")(function* () {
      if (!(yield* getEnv("GITLAB_CI"))) return undefined;
      const token = yield* getEnv("SIGSTORE_ID_TOKEN");
      return token ? Redacted.make(token) : undefined;
    }),
  },
  {
    // Cloud Run, Cloud Functions, and GCE: the metadata server signs
    // identity tokens for the instance's service account.
    name: "gcp",
    probe: Effect.fn("oidc.gcp")(function* (audience) {
      const onGcp =
        (yield* getEnv("K_SERVICE")) ||
        (yield* getEnv("GCE_METADATA_HOST")) ||
        (yield* getEnv("GOOGLE_CLOUD_PROJECT"));
      if (!onGcp) return undefined;

      const url = new URL(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
      );
      if (audience !== undefined) url.searchParams.set("audience", audience);
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(url, {
        headers: { "Metadata-Flavor": "Google" },
      });
      if (response.status !== 200) return undefined;
      const token = (yield* response.text).trim();
      return token ? Redacted.make(token) : undefined;
    }),
  },
];

/**
 * Find the OIDC token of the platform this process is running on. The
 * caller's explicit variable wins; otherwise platforms are probed in
 * order and the first token wins. A probe that fails or hangs counts as
 * "not this platform". `undefined` means nothing was detected.
 */
export const detectOidcToken = Effect.fn("detectOidcToken")(function* (
  env: OidcTokenEnv,
) {
  const explicit = yield* getEnv(env.token);
  if (explicit) {
    const found: OidcToken = {
      platform: "explicit",
      token: Redacted.make(explicit),
    };
    return found;
  }

  const audience = yield* getEnv(env.audience);
  for (const platform of PLATFORMS) {
    const token = yield* platform.probe(audience).pipe(
      Effect.timeout(PROBE_TIMEOUT),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (token !== undefined) {
      const found: OidcToken = { platform: platform.name, token };
      return found;
    }
  }
  return undefined;
});
