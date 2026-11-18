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

    // Legacy provisioned bearer: the fixed slot, no renewal — the provisioner
    // replaces it when it expires (spec section 4.2). Read once per provider;
    // each operation opens a fresh provider, so the slot is re-read per op.
    let staticCredential: string | undefined;
    if (auth.mode === "static") {
      const stored = yield* secrets.get(GATEWAY_CREDENTIAL_SLOT);
      staticCredential = Option.isSome(stored) ? decoder.decode(stored.value) : "";
    }

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
    const usable = (now: number): boolean =>
      cached !== undefined && cached.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > now;
    const currentToken = (): string => {
      const snapshot = cached;
      if (snapshot === undefined || !usable(Date.now()))
        throw new Error("The gateway token needs renewal.");
      return snapshot.token;
    };

    if (auth.mode === "mtls") {
      return yield* new GatewayAuthError({
        message:
          "Gateway auth mode mtls needs the client-certificate transport, which the " +
          "OpenShell SDK seam does not expose yet; configure client-credentials, " +
          "oidc-pkce, or static.",
      });
    }

    /** OAuth2 client-credentials or refresh-token grant against the OIDC issuer. */
    const fetchToken = async (
      issuer: string,
      audience: string | undefined,
      form: URLSearchParams,
    ): Promise<string> => {
      if (tokenEndpoint === undefined) {
        const discovery = await doFetch(new URL(".well-known/openid-configuration", issuer));
        if (!discovery.ok)
          throw new Error(`OIDC discovery at ${issuer} failed with status ${discovery.status}.`);
        const document = (await discovery.json()) as { readonly token_endpoint?: unknown };
        if (typeof document.token_endpoint !== "string" || document.token_endpoint === "")
          throw new Error(`OIDC discovery at ${issuer} has no token endpoint.`);
        tokenEndpoint = document.token_endpoint;
      }
      const response = await doFetch(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (!response.ok) throw new Error(`The gateway token endpoint answered ${response.status}.`);
      const payload = (await response.json()) as {
        readonly access_token?: unknown;
        readonly expires_in?: unknown;
      };
      if (typeof payload.access_token !== "string" || payload.access_token === "")
        throw new Error("The gateway token endpoint returned no access token.");
      const lifetime =
        typeof payload.expires_in === "number" && payload.expires_in > 0
          ? payload.expires_in * 1000
          : 300_000;
      cached = { token: payload.access_token, expiresAtMs: Date.now() + lifetime };
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
      const issuer = auth.issuer;
      const audience = auth.audience;
      return {
        oidcTokenProvider: (): Promise<string> => {
          if (usable(Date.now())) return Promise.resolve(currentToken());
          const form = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          });
          if (issuer !== undefined) form.set("issuer", issuer);
          if (audience !== undefined) form.set("audience", audience);
          return fetchToken(issuer ?? "", audience, form);
        },
      };
    }

    // static
    const oidcTokenProvider = (): Promise<string> => Promise.resolve(staticCredential ?? "");
    return { oidcTokenProvider };
  },
);
