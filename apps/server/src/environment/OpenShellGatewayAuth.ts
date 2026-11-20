// @effect-diagnostics globalDate:off - the token provider is a Promise-shaped
// collaborator of the SDK (like the driver and the smoke script), so its cache
// checks wall-clock time outside the Effect runtime.
import type { OpenShellGatewayAuth, SettingsSecretValue } from "@t3tools/contracts";
import * as SecretResolverCore from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { openshellGatewayAuthSecretName } from "../settingsSecrets.ts";

/**
 * Turns the settings' `OpenShellGatewayAuth` into the SDK's `oidcTokenProvider`
 * seam — an async bearer getter the client renews through. Secret literals live
 * in the server secret store (settings JSON keeps the redacted placeholder) and
 * secret-provider references are read through the resolver (spec section 4.2).
 */

const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";
const GATEWAY_CREDENTIAL_SLOT = "openshell-gateway-credential";

export interface GatewayAuthTokenProviderDeps {
  readonly auth: OpenShellGatewayAuth;
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly resolver: SecretResolverCore.SecretResolver["Service"];
  /** Overridable for tests. */
  readonly fetchImpl?: typeof fetch;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

/** Gateway auth failures: typed so a fleet operation maps them to its own error. */
export class GatewayAuthError extends Schema.TaggedError<GatewayAuthError>()("GatewayAuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const isRedacted = (value: SettingsSecretValue): boolean =>
  typeof value === "string" && value === REDACTED;

export const makeGatewayAuthTokenProvider = Effect.fn("OpenShellGatewayAuth.tokenProvider")(
  function* (deps: GatewayAuthTokenProviderDeps) {
    const { auth, secrets, resolver, fetchImpl } = deps;
    const doFetch = fetchImpl ?? fetch;
    const decoder = new TextDecoder();
    /** Promise collaborators run with the same services as this Effect. */
    const runtime = yield* Effect.context<never>();

    const resolveSecretField = Effect.fn("OpenShellGatewayAuth.resolveSecretField")(function* (
      field: string,
      value: SettingsSecretValue,
    ) {
      if (isRedacted(value)) {
        const stored = yield* secrets.get(openshellGatewayAuthSecretName(field));
        const secret = Option.isSome(stored) ? decoder.decode(stored.value) : "";
        if (secret === "")
          return yield* new GatewayAuthError({
            message: `The gateway auth secret "${field}" is not set.`,
          });
        return secret;
      }
      const secret = yield* requireSettingsSecret(resolver, value).pipe(
        Effect.catch(
          (cause) =>
            new GatewayAuthError({
              message: `The gateway auth secret "${field}" could not be read.`,
              cause,
            }),
        ),
      );
      if (secret.trim() === "")
        return yield* new GatewayAuthError({
          message: `The gateway auth secret "${field}" is empty.`,
        });
      return secret;
    });

    let cached: CachedToken | undefined;
    let tokenEndpoint: string | undefined;
    let refreshInFlight: Promise<string> | undefined;
    const usable = (now: number): boolean =>
      cached !== undefined && cached.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > now;
    const currentToken = (): string => {
      const snapshot = cached;
      if (snapshot === undefined || !usable(Date.now()))
        throw new Error("The gateway token needs renewal.");
      return snapshot.token;
    };

    if (auth.mode === "mtls") {
      // Lane 1 auth docs: the SDK connect accepts caCert + clientCert +
      // clientKey for client-CA gateways. Field shapes still need
      // type-level verification against SDK 0.1.7.
      const clientKey = yield* resolveSecretField("clientKey", auth.clientKey);
      return {
        connectOptions: {
          ...(auth.caCertPem === undefined ? {} : { caCert: auth.caCertPem }),
          clientCert: auth.clientCertPem,
          clientKey,
        },
      };
    }

    /** OAuth2 client-credentials or refresh-token grant against the OIDC issuer. */
    const fetchToken = async (
      issuer: string,
      audience: string | undefined,
      form: URLSearchParams,
    ): Promise<string> => {
      if (tokenEndpoint === undefined) {
        // Preserve tenant paths: discovery is relative to the issuer, not its origin.
        const issuerUrl = new URL(issuer);
        const issuerBase = issuerUrl.pathname.endsWith("/") ? issuer : `${issuer}/`;
        const discovery = await doFetch(new URL(".well-known/openid-configuration", issuerBase), {
          redirect: "error",
        });
        if (!discovery.ok)
          throw new Error(`OIDC discovery at ${issuer} failed with status ${discovery.status}.`);
        const document = (await discovery.json()) as {
          readonly issuer?: unknown;
          readonly token_endpoint?: unknown;
        };
        if (typeof document.token_endpoint !== "string" || document.token_endpoint === "")
          throw new Error(`OIDC discovery at ${issuer} has no token endpoint.`);
        const tokenUrl = new URL(document.token_endpoint);
        const secureEndpoint = (url: URL) =>
          url.protocol === "https:" ||
          (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
        if (!secureEndpoint(issuerUrl) || !secureEndpoint(tokenUrl))
          throw new Error("OIDC discovery requires HTTPS endpoints outside local development.");
        if (
          typeof document.issuer === "string" &&
          document.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")
        )
          throw new Error(`OIDC discovery at ${issuer} identifies a different issuer.`);
        tokenEndpoint = document.token_endpoint;
      }
      const response = await doFetch(tokenEndpoint, {
        redirect: "error",
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (!response.ok) throw new Error(`The gateway token endpoint answered ${response.status}.`);
      const payload = (await response.json()) as {
        readonly access_token?: unknown;
        readonly expires_in?: unknown;
        readonly refresh_token?: unknown;
      };
      if (typeof payload.access_token !== "string" || payload.access_token === "")
        throw new Error("The gateway token endpoint returned no access token.");
      const lifetime =
        typeof payload.expires_in === "number" && payload.expires_in > 0
          ? payload.expires_in * 1000
          : 300_000;
      cached = { token: payload.access_token, expiresAtMs: Date.now() + lifetime };
      // Rotation is opt-in at the protocol level. For a stored literal, rotate
      // the server slot immediately; an external secret owner is authoritative
      // and cannot be silently overwritten here.
      if (
        auth.mode === "oidc-pkce" &&
        typeof payload.refresh_token === "string" &&
        payload.refresh_token !== "" &&
        isRedacted(auth.refreshToken)
      ) {
        await Effect.runPromiseWith(runtime)(
          secrets
            .set(
              openshellGatewayAuthSecretName("refreshToken"),
              new TextEncoder().encode(payload.refresh_token),
            )
            .pipe(
              Effect.catch(
                (cause) =>
                  new GatewayAuthError({
                    message:
                      "The issuer rotated the gateway refresh token, but its server slot could not be updated.",
                    cause,
                  }),
              ),
            ),
        );
      }
      return cached.token;
    };

    if (auth.mode === "client-credentials") {
      const clientSecret = yield* resolveSecretField("clientSecret", auth.clientSecret);
      const issuer = auth.issuer;
      const audience = auth.audience;
      return {
        oidcTokenProvider: (): Promise<string> => {
          if (usable(Date.now())) return Promise.resolve(currentToken());
          const form = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: auth.clientId,
            client_secret: clientSecret,
          });
          if (audience !== undefined) form.set("audience", audience);
          return fetchToken(issuer, audience, form);
        },
      };
    }

    if (auth.mode === "oidc-pkce") {
      // The desktop performed the browser login; the server holds the refresh
      // token and renews with the refresh-token grant (spec section 4.1).
      const refreshToken = yield* resolveSecretField("refreshToken", auth.refreshToken);
      const configuredIssuer = auth.issuer;
      if (configuredIssuer === undefined || configuredIssuer.trim() === "") {
        return yield* new GatewayAuthError({
          message: "OIDC refresh authentication requires an issuer.",
        });
      }
      const issuer = configuredIssuer;
      const audience = auth.audience;
      return {
        oidcTokenProvider: (): Promise<string> => {
          if (usable(Date.now())) return Promise.resolve(currentToken());
          // OAuth refresh codes are single-use: serialize callers so concurrent
          // operations cannot spend the same token twice.
          refreshInFlight ??= (async () => {
            try {
              const form = new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
              });
              if (issuer !== undefined) form.set("issuer", issuer);
              if (audience !== undefined) form.set("audience", audience);
              return await fetchToken(issuer, audience, form);
            } finally {
              refreshInFlight = undefined;
            }
          })();
          return refreshInFlight;
        },
      };
    }

    // static
    // Legacy provisioned bearer: read the slot on every token callback so a
    // provisioner can replace an expired credential without rebuilding driver.
    const oidcTokenProvider = (): Promise<string> =>
      Effect.runPromiseWith(runtime)(
        secrets
          .get(GATEWAY_CREDENTIAL_SLOT)
          .pipe(
            Effect.map((stored) => (Option.isSome(stored) ? decoder.decode(stored.value) : "")),
          ),
      );
    return { oidcTokenProvider };
  },
);
